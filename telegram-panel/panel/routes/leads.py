"""The Leads page + CSV export: fans Capitalbot reported as converted (PLAN.md §6).

Read-only. Rows are written by the AI worker (service._ensure_lead on a converted turn) and by the
one-time startup backfill (service.backfill_leads). Assigned-VA is always blank: the portal owns
attribution and the panel never receives it back.
"""

import csv
import io
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, Request
from fastapi.responses import StreamingResponse
from sqlalchemy import select

from panel.auth import require_login
from panel.models import Account, Lead

router = APIRouter(prefix="/api/leads", dependencies=[Depends(require_login)])

# (row key, CSV header) in export order.
COLUMNS = [
    ("fan_user_id", "Fan Telegram ID"),
    ("fan_username", "Fan username"),
    ("fan_name", "Display name"),
    ("fan_phone", "Phone"),
    ("account_username", "Account"),
    ("profile_name", "Model/persona"),
    ("capital_model_id", "Model ID"),
    ("capital_preset_id", "Preset ID"),
    ("va", "Assigned VA"),
    ("first_msg_at", "First message"),
    ("converted_at", "Converted"),
    ("tme_link", "t.me link"),
]


def _service(request: Request):
    return request.app.state.service


def _parse_dt(s: str | None) -> datetime | None:
    if not s:
        return None
    try:
        d = datetime.fromisoformat(s.replace("Z", "+00:00"))
    except ValueError:
        return None
    return d if d.tzinfo else d.replace(tzinfo=timezone.utc)


def _filters(params):
    """(SQL where-clauses, lowercased free-text query) from the request's query string."""
    where = []
    account_id = params.get("account_id")
    if account_id and account_id.isdigit():
        where.append(Lead.account_id == int(account_id))
    model = params.get("model")  # Capitalbot model id
    if model and model.lstrip("-").isdigit():
        where.append(Lead.capital_model_id == int(model))
    frm, to = _parse_dt(params.get("from")), _parse_dt(params.get("to"))
    if frm is not None:
        where.append(Lead.converted_at >= frm)
    if to is not None:
        where.append(Lead.converted_at <= to)
    return where, (params.get("q") or "").strip().lower()


def _row(lead: Lead, account_username: str | None) -> dict:
    return {
        "id": lead.id,
        "fan_user_id": lead.fan_user_id,
        "fan_username": lead.fan_username,
        "fan_name": lead.fan_name,
        "fan_phone": lead.fan_phone,
        "account_username": account_username,
        "profile_name": lead.profile_name,
        "capital_model_id": lead.capital_model_id,
        "capital_preset_id": lead.capital_preset_id,
        "va": "",  # the panel has no portal attribution; blank by design
        "first_msg_at": lead.first_msg_at.isoformat() if lead.first_msg_at else None,
        "converted_at": lead.converted_at.isoformat() if lead.converted_at else None,
        "tme_link": f"https://t.me/{lead.fan_username}" if lead.fan_username else None,
    }


async def _rows(session, where, q: str) -> list[dict]:
    stmt = (
        select(Lead, Account.username)
        .join(Account, Account.id == Lead.account_id)
        .where(*where)
        .order_by(Lead.converted_at.desc())
    )
    out = []
    for lead, account_username in (await session.execute(stmt)).all():
        row = _row(lead, account_username)
        if q:
            hay = " ".join(str(v) for v in (row["fan_username"], row["fan_name"], row["fan_user_id"]) if v).lower()
            if q not in hay:
                continue
        out.append(row)
    return out


@router.get("")
async def list_leads(request: Request) -> dict:
    where, q = _filters(request.query_params)
    async with _service(request).sessionmaker() as session:
        rows = await _rows(session, where, q)
        accounts = (
            await session.execute(
                select(Account.id, Account.username).join(Lead, Lead.account_id == Account.id).distinct().order_by(Account.username)
            )
        ).all()
        models = (
            await session.execute(select(Lead.capital_model_id, Lead.profile_name).where(Lead.capital_model_id.is_not(None)).distinct())
        ).all()
    model_opts = sorted({(m, n) for m, n in models}, key=lambda x: (x[1] or "", x[0] or 0))
    return {
        "leads": rows,
        "total": len(rows),
        "accounts": [{"id": a, "username": u} for a, u in accounts],
        "models": [{"id": m, "name": n} for m, n in model_opts],
    }


def _csv_cell(value) -> str:
    """Stringify a cell and neutralise spreadsheet-formula injection: a fan can set their Telegram
    name to '=…', so any cell that starts with = + - @ (or a control char) is prefixed with a quote."""
    if value is None:
        return ""
    s = str(value)
    if s and s[0] in ("=", "+", "-", "@", "\t", "\r"):
        return "'" + s
    return s


@router.get("/export")
async def export_leads(request: Request) -> StreamingResponse:
    where, q = _filters(request.query_params)
    async with _service(request).sessionmaker() as session:
        rows = await _rows(session, where, q)
    buf = io.StringIO()
    writer = csv.writer(buf)
    writer.writerow([label for _k, label in COLUMNS])
    for r in rows:
        writer.writerow([_csv_cell(r.get(k)) for k, _label in COLUMNS])
    filename = f"converted-leads-{datetime.now(timezone.utc).strftime('%Y%m%d-%H%M')}.csv"
    return StreamingResponse(
        iter([buf.getvalue()]),
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )
