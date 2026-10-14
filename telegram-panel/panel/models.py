"""Tables (PLAN.md §3). The full schema is created up front, so later build steps add
behaviour, not columns. Times are stored as UTC and always come back timezone-aware."""

from datetime import datetime, timezone
from typing import Any

from sqlalchemy import (
    JSON,
    BigInteger,
    Boolean,
    DateTime,
    ForeignKey,
    Integer,
    LargeBinary,
    String,
    Text,
    TypeDecorator,
    UniqueConstraint,
)
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


class UTCDateTime(TypeDecorator[datetime]):
    """SQLite has no timezone type: store naive UTC, hand back aware UTC."""

    impl = DateTime
    cache_ok = True

    def process_bind_param(self, value: datetime | None, dialect: Any) -> datetime | None:
        if value is None:
            return None
        if value.tzinfo is None:
            raise ValueError("naive datetime; use timezone-aware UTC")
        return value.astimezone(timezone.utc).replace(tzinfo=None)

    def process_result_value(self, value: datetime | None, dialect: Any) -> datetime | None:
        return value.replace(tzinfo=timezone.utc) if value is not None else None


class Base(DeclarativeBase):
    pass


class Profile(Base):
    """A persona sent to Capitalbot, shared by many accounts."""

    __tablename__ = "profiles"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(100))
    capital_model_id: Mapped[int] = mapped_column(Integer)
    capital_preset_id: Mapped[int] = mapped_column(Integer)
    overrides: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow, onupdate=utcnow)


class Account(Base):
    __tablename__ = "accounts"

    id: Mapped[int] = mapped_column(primary_key=True)
    tg_user_id: Mapped[int] = mapped_column(BigInteger, unique=True)
    username: Mapped[str | None] = mapped_column(String(64), index=True)  # lowercase, no @
    phone: Mapped[str | None] = mapped_column(String(32))
    first_name: Mapped[str | None] = mapped_column(String(128))

    session_enc: Mapped[bytes] = mapped_column(LargeBinary)
    # sha256 of the auth key: a re-uploaded session is spotted without opening a second connection
    auth_key_sha256: Mapped[str] = mapped_column(String(64), unique=True)
    api_id: Mapped[int] = mapped_column(Integer)
    api_hash: Mapped[str] = mapped_column(String(64))
    device_model: Mapped[str | None] = mapped_column(String(128))
    system_version: Mapped[str | None] = mapped_column(String(128))
    app_version: Mapped[str | None] = mapped_column(String(64))
    lang_code: Mapped[str | None] = mapped_column(String(16))
    system_lang_code: Mapped[str | None] = mapped_column(String(16))
    twofa_enc: Mapped[bytes | None] = mapped_column(LargeBinary)
    proxy_enc: Mapped[bytes | None] = mapped_column(LargeBinary)

    power_on: Mapped[bool] = mapped_column(Boolean, default=True)
    ai_on: Mapped[bool] = mapped_column(Boolean, default=False)
    profile_id: Mapped[int | None] = mapped_column(ForeignKey("profiles.id", ondelete="SET NULL"))
    profile_overrides: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)

    # offline · connecting · online · limited · banned · revoked · error
    status: Mapped[str] = mapped_column(String(16), default="offline")
    status_detail: Mapped[str | None] = mapped_column(Text)
    last_msg_at: Mapped[datetime | None] = mapped_column(UTCDateTime)
    last_incoming_at: Mapped[datetime | None] = mapped_column(UTCDateTime)
    avatar_path: Mapped[str | None] = mapped_column(String(255))

    created_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow, onupdate=utcnow)


class Chat(Base):
    __tablename__ = "chats"
    __table_args__ = (UniqueConstraint("account_id", "peer_id"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    account_id: Mapped[int] = mapped_column(ForeignKey("accounts.id", ondelete="CASCADE"), index=True)
    peer_id: Mapped[str] = mapped_column(String(32))
    peer_username: Mapped[str | None] = mapped_column(String(64))
    peer_name: Mapped[str | None] = mapped_column(String(256))
    peer_phone: Mapped[str | None] = mapped_column(String(32))  # E.164 with +

    first_in_at: Mapped[datetime | None] = mapped_column(UTCDateTime)
    first_reply_at: Mapped[datetime | None] = mapped_column(UTCDateTime)
    reported_first: Mapped[bool] = mapped_column(Boolean, default=False)
    reported_reply: Mapped[bool] = mapped_column(Boolean, default=False)

    # active · converted · stopped · filtered
    ai_state: Mapped[str] = mapped_column(String(16), default="active")
    ai_state_reason: Mapped[str | None] = mapped_column(String(32))
    cooldown_until: Mapped[datetime | None] = mapped_column(UTCDateTime)
    capital_conversation_id: Mapped[int | None] = mapped_column(BigInteger)
    media_uploads: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)

    last_in_at: Mapped[datetime | None] = mapped_column(UTCDateTime)
    last_out_at: Mapped[datetime | None] = mapped_column(UTCDateTime)


class Message(Base):
    __tablename__ = "messages"
    __table_args__ = (UniqueConstraint("account_id", "peer_id", "tg_msg_id"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    account_id: Mapped[int] = mapped_column(ForeignKey("accounts.id", ondelete="CASCADE"))
    peer_id: Mapped[str] = mapped_column(String(32))
    tg_msg_id: Mapped[int] = mapped_column(BigInteger)
    direction: Mapped[str] = mapped_column(String(3))  # in · out
    sender: Mapped[str] = mapped_column(String(8))  # fan · ai · manual
    kind: Mapped[str] = mapped_column(String(10))  # text · image · video · audio · gif · sticker · location · other
    text: Mapped[str | None] = mapped_column(Text)
    at: Mapped[datetime] = mapped_column(UTCDateTime, index=True)


class OutboxItem(Base):
    """Everything bound for the portal. Signed at send time, never at enqueue time."""

    __tablename__ = "outbox"

    id: Mapped[int] = mapped_column(primary_key=True)
    kind: Mapped[str] = mapped_column(String(16))  # convo · account_status
    dedupe_key: Mapped[str | None] = mapped_column(String(200), index=True)
    payload: Mapped[dict[str, Any]] = mapped_column(JSON)
    status: Mapped[str] = mapped_column(String(8), default="pending", index=True)  # pending · sent · failed
    attempts: Mapped[int] = mapped_column(Integer, default=0)
    next_attempt_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow)
    last_error: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow)
    sent_at: Mapped[datetime | None] = mapped_column(UTCDateTime)


class ImportJob(Base):
    __tablename__ = "import_jobs"

    id: Mapped[str] = mapped_column(String(32), primary_key=True)
    profile_id: Mapped[int | None] = mapped_column(ForeignKey("profiles.id", ondelete="SET NULL"))
    done: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow)


class ImportItem(Base):
    __tablename__ = "import_items"

    id: Mapped[int] = mapped_column(primary_key=True)
    job_id: Mapped[str] = mapped_column(ForeignKey("import_jobs.id", ondelete="CASCADE"), index=True)
    filename: Mapped[str] = mapped_column(String(255))
    result: Mapped[str] = mapped_column(String(12), default="pending")  # pending · connected · dead · duplicate · invalid
    detail: Mapped[str | None] = mapped_column(Text)
    username: Mapped[str | None] = mapped_column(String(64))
    phone: Mapped[str | None] = mapped_column(String(32))


class Activity(Base):
    __tablename__ = "activity"

    id: Mapped[int] = mapped_column(primary_key=True)
    at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow, index=True)
    level: Mapped[str] = mapped_column(String(8))  # info · warn · error
    kind: Mapped[str] = mapped_column(String(32))
    account_id: Mapped[int | None] = mapped_column(ForeignKey("accounts.id", ondelete="SET NULL"))
    message: Mapped[str] = mapped_column(Text)


class Setting(Base):
    __tablename__ = "settings"

    key: Mapped[str] = mapped_column(String(64), primary_key=True)
    value: Mapped[Any] = mapped_column(JSON)
