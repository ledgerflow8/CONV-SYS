"""Personas (Capitalbot model + preset + overrides) and the model/preset catalog (PLAN.md §5, §6.5)."""

import logging

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import func, select

from panel.auth import require_login
from panel.capital import ALLOWED_OVERRIDE_KEYS, CapitalError
from panel.models import Account, Profile, utcnow

router = APIRouter(prefix="/api", dependencies=[Depends(require_login)])

log = logging.getLogger("panel.routes.profiles")


def _clean_overrides(overrides: dict | None) -> dict:
    """Keep only the keys Capitalbot accepts (PLAN.md §3); drop everything else silently."""
    return {k: v for k, v in (overrides or {}).items() if k in ALLOWED_OVERRIDE_KEYS and v is not None}


def _profile_dict(p: Profile) -> dict:
    return {
        "id": p.id,
        "name": p.name,
        "capital_model_id": p.capital_model_id,
        "capital_preset_id": p.capital_preset_id,
        "overrides": p.overrides or {},
    }


@router.get("/capital/catalog")
async def catalog(request: Request) -> dict:
    capital = request.app.state.capital
    if not capital.configured:
        return {"configured": False, "models": [], "presets": []}
    try:
        data = await capital.catalog()
    except CapitalError as e:
        log.warning("catalog failed: %s", e.detail)
        raise HTTPException(502, f"Capitalbot catalog unavailable: {e.detail}") from e
    return {"configured": True, **data}


@router.get("/profiles")
async def list_profiles(request: Request) -> dict:
    async with request.app.state.service.sessionmaker() as session:
        rows = (await session.scalars(select(Profile).order_by(Profile.name))).all()
        # Count accounts per profile so the UI can warn before a delete.
        counts = dict(
            (await session.execute(select(Account.profile_id, func.count()).group_by(Account.profile_id))).all()
        )
    return {"profiles": [{**_profile_dict(p), "accounts": counts.get(p.id, 0)} for p in rows]}


class ProfileBody(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    capital_model_id: int
    capital_preset_id: int
    overrides: dict = Field(default_factory=dict)

    @field_validator("name")
    @classmethod
    def _strip(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("name can't be blank")
        return v


@router.post("/profiles")
async def create_profile(body: ProfileBody, request: Request) -> dict:
    async with request.app.state.service.sessionmaker() as session:
        p = Profile(
            name=body.name,
            capital_model_id=body.capital_model_id,
            capital_preset_id=body.capital_preset_id,
            overrides=_clean_overrides(body.overrides),
        )
        session.add(p)
        await session.commit()
        return _profile_dict(p)


@router.patch("/profiles/{profile_id}")
async def update_profile(profile_id: int, body: ProfileBody, request: Request) -> dict:
    async with request.app.state.service.sessionmaker() as session:
        p = await session.get(Profile, profile_id)
        if not p:
            raise HTTPException(404, "No such persona")
        p.name = body.name
        p.capital_model_id = body.capital_model_id
        p.capital_preset_id = body.capital_preset_id
        p.overrides = _clean_overrides(body.overrides)
        p.updated_at = utcnow()
        await session.commit()
        return _profile_dict(p)


@router.delete("/profiles/{profile_id}")
async def delete_profile(profile_id: int, request: Request) -> dict:
    async with request.app.state.service.sessionmaker() as session:
        p = await session.get(Profile, profile_id)
        if not p:
            raise HTTPException(404, "No such persona")
        in_use = await session.scalar(select(func.count()).select_from(Account).where(Account.profile_id == profile_id))
        if in_use:
            raise HTTPException(409, f"{in_use} account(s) still use this persona. Move them first.")
        await session.delete(p)
        await session.commit()
    return {"ok": True}
