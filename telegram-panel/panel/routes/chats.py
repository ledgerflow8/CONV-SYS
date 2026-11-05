"""Chat logs (client 2026-11-05): every chat with its AI outcome, and per chat the last 50 messages
read live from Telegram next to the AI log (ai_events) timeline, so the client can see what the AI
is saying and why a fan did or didn't get a reply. Read-only."""

from datetime import datetime, time, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy import exists, func, or_, select

from panel import ailog
from panel.auth import require_login
from panel.db import get_setting
from panel.models import Account, AiEvent, Chat, Message
from panel.tg.client import TgError

router = APIRouter(prefix="/api/chats", dependencies=[Depends(require_login)])

PAGE_MAX = 100
LIVE_MESSAGES = 50
TIMELINE_MAX = 300


def _service(request: Request):
    return request.app.state.service


def _day(s: str | None, end: bool = False) -> datetime | None:
    """A YYYY-MM-DD (UTC) filter bound; `end` makes it inclusive of that whole day."""
    if not s:
        return None
    try:
        d = datetime.fromisoformat(s)
    except ValueError:
        raise HTTPException(400, f"Not a date: {s}") from None
    if d.tzinfo is None:
        d = d.replace(tzinfo=timezone.utc)
    if end and d.timetz().replace(tzinfo=None) == time(0):
        d += timedelta(days=1)
    return d


def _ai_replied(log_started: datetime | None):
    """SQL: the AI delivered a qualifying reply in this chat: the AI log, or a stored AI message from
    before the log existed (the same evidence as Service.ai_reply_at)."""
    logged = exists().where(
        AiEvent.account_id == Chat.account_id, AiEvent.peer_id == Chat.peer_id,
        AiEvent.kind == ailog.AI_REPLY_SENT, AiEvent.capital_status == ailog.OK,
    )
    before_log = [Message.at < log_started] if log_started else []
    stored = exists().where(Message.account_id == Chat.account_id, Message.peer_id == Chat.peer_id, Message.sender == "ai", *before_log)
    return or_(logged, stored)


async def _log_started(session) -> datetime | None:
    v = await get_setting(session, ailog.LOG_STARTED_AT)
    return datetime.fromisoformat(v) if v else None


@router.get("")
async def list_chats(
    request: Request,
    account_id: int | None = None,
    date_from: str | None = None,
    date_to: str | None = None,
    ai_replied: str | None = None,  # yes · no
    capital_status: str | None = None,  # chats with any AI-log row in this status
    offset: int = 0,
    limit: int = 50,
) -> dict:
    limit = max(1, min(PAGE_MAX, limit))
    where = []
    if account_id is not None:
        where.append(Chat.account_id == account_id)
    lo, hi = _day(date_from), _day(date_to, end=True)
    if lo is not None:
        where.append(Chat.first_in_at >= lo)
    if hi is not None:
        where.append(Chat.first_in_at < hi)
    if capital_status:
        if capital_status not in ailog.STATUSES:
            raise HTTPException(400, f"capital_status must be one of {', '.join(ailog.STATUSES)}")
        where.append(
            exists().where(AiEvent.account_id == Chat.account_id, AiEvent.peer_id == Chat.peer_id, AiEvent.capital_status == capital_status)
        )
    async with _service(request).sessionmaker() as s:
        replied_sql = _ai_replied(await _log_started(s))
        if ai_replied in ("yes", "no"):
            where.append(replied_sql if ai_replied == "yes" else ~replied_sql)
        total = await s.scalar(select(func.count()).select_from(Chat).where(*where))
        rows = (
            await s.execute(
                select(Chat, Account.username, replied_sql.label("ai_replied"))
                .join(Account, Account.id == Chat.account_id)
                .where(*where)
                .order_by(func.coalesce(Chat.last_in_at, Chat.last_out_at, Chat.first_in_at).desc().nullslast(), Chat.id.desc())
                .offset(max(0, offset))
                .limit(limit)
            )
        ).all()
        # The latest AI-log status per listed chat, in one query.
        keys = [(c.account_id, c.peer_id) for c, _u, _r in rows]
        latest: dict[tuple[int, str], tuple[str | None, datetime]] = {}
        if keys:
            peer_ids = list({p for _a, p in keys})
            evs = (
                await s.execute(
                    select(AiEvent.account_id, AiEvent.peer_id, AiEvent.capital_status, AiEvent.created_at)
                    .where(AiEvent.peer_id.in_(peer_ids), AiEvent.capital_status.is_not(None))
                    .order_by(AiEvent.id)
                )
            ).all()
            wanted = set(keys)
            for a, p, st, at in evs:
                if (a, p) in wanted:
                    latest[(a, p)] = (st, at)
        accounts = (await s.execute(select(Account.id, Account.username).order_by(Account.username))).all()
    return {
        "total": total or 0,
        "chats": [
            {
                "account_id": c.account_id,
                "account": username,
                "peer_id": c.peer_id,
                "peer_name": c.peer_name,
                "peer_username": c.peer_username,
                "first_in_at": c.first_in_at.isoformat() if c.first_in_at else None,
                "reported_replied_at": c.first_reply_at.isoformat() if c.reported_reply and c.first_reply_at else None,
                "last_at": _iso(max((t for t in (c.last_in_at, c.last_out_at) if t), default=c.first_in_at)),
                "ai_state": c.ai_state,
                "ai_state_reason": c.ai_state_reason,
                "ai_replied": bool(replied),
                "last_status": latest.get((c.account_id, c.peer_id), (None, None))[0],
            }
            for c, username, replied in rows
        ],
        "accounts": [{"id": i, "username": u} for i, u in accounts],
        "statuses": list(ailog.STATUSES),
    }


@router.get("/{account_id}/{peer_id}")
async def chat_detail(account_id: int, peer_id: str, request: Request) -> dict:
    service = _service(request)
    async with service.sessionmaker() as s:
        acc = await s.get(Account, account_id)
        chat = await s.scalar(select(Chat).where(Chat.account_id == account_id, Chat.peer_id == peer_id))
        if acc is None or chat is None:
            raise HTTPException(404, "No such chat")
        events = (
            await s.scalars(
                select(AiEvent)
                .where(AiEvent.account_id == account_id, AiEvent.peer_id == peer_id)
                .order_by(AiEvent.id.desc())
                .limit(TIMELINE_MAX)
            )
        ).all()
        stored = (
            await s.scalars(
                select(Message).where(Message.account_id == account_id, Message.peer_id == peer_id).order_by(Message.at.desc()).limit(LIVE_MESSAGES)
            )
        ).all()
        senders = dict(
            (await s.execute(select(Message.tg_msg_id, Message.sender).where(Message.account_id == account_id, Message.peer_id == peer_id))).all()
        )
        ai_replied = await service.ai_reply_at(s, account_id, peer_id, chat.first_in_at or datetime(1970, 1, 1, tzinfo=timezone.utc)) is not None

    source, note = "telegram", None
    client = service.manager.get(account_id)
    msgs: list[dict] = []
    if client is None:
        source, note = "stored", "The account isn't connected, so these are the messages the panel has stored (older ones are pruned)."
    else:
        try:
            live = await client.recent_messages(int(peer_id), LIVE_MESSAGES, access_hash=chat.access_hash)
        except TgError as e:
            source, note = "stored", f"Couldn't read the chat from Telegram ({e.detail}); showing the messages the panel has stored."
        else:
            msgs = [_msg(m.tg_msg_id, m.out, m.kind, m.text, m.at, senders.get(m.tg_msg_id)) for m in live]
    if source == "stored":
        msgs = [_msg(m.tg_msg_id, m.direction == "out", m.kind, m.text, m.at, m.sender) for m in reversed(stored)]

    return {
        "chat": {
            "account_id": account_id,
            "account": acc.username or str(acc.tg_user_id),
            "peer_id": peer_id,
            "peer_name": chat.peer_name,
            "peer_username": chat.peer_username,
            "first_in_at": chat.first_in_at.isoformat() if chat.first_in_at else None,
            "reported_replied_at": chat.first_reply_at.isoformat() if chat.reported_reply and chat.first_reply_at else None,
            "ai_state": chat.ai_state,
            "ai_state_reason": chat.ai_state_reason,
            "ai_replied": ai_replied,
        },
        "messages": msgs,
        "source": source,
        "note": note,
        "events": [
            {"id": e.id, "at": e.created_at.isoformat(), "kind": e.kind, "capital_status": e.capital_status, "text": e.text, "error": e.error}
            for e in reversed(events)
        ],
    }


def _iso(d: datetime | None) -> str | None:
    return d.isoformat() if d else None


def _msg(tg_msg_id: int, out: bool, kind: str, text: str | None, at: datetime, sender: str | None) -> dict:
    # side: who wrote it. by (model side only): ai = the panel's AI sent it; other = typed by hand,
    # another session or before the panel (the panel didn't send it).
    return {
        "id": tg_msg_id,
        "at": at.isoformat(),
        "side": "model" if out else "fan",
        "by": ("ai" if sender == "ai" else "other") if out else None,
        "kind": kind,
        "text": text,
    }
