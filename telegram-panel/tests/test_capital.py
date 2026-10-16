"""The Capitalbot client (panel/capital.py): request/response contract and the retry policy."""

from datetime import datetime, timezone

import httpx
import pytest

from panel.ai import build_chat_history
from panel.capital import CapitalClient, CapitalError
from panel.models import Message


def _msg(direction, kind, text, ts):
    return Message(account_id=1, peer_id="5", tg_msg_id=ts, direction=direction, kind=kind, text=text, at=datetime.fromtimestamp(ts, tz=timezone.utc))


# ── chatHistory builder (an invariant: every entry carries an integer timestamp) ──
def test_history_roles_markers_and_integer_timestamps():
    msgs = [
        _msg("in", "text", "hey", 1000),
        _msg("out", "text", "hi babe", 1005),
        _msg("in", "image", None, 1010),
        _msg("in", "text", "   ", 1011),  # blank → dropped
    ]
    h = build_chat_history(msgs)
    assert [m["role"] for m in h] == ["user", "assistant", "user"]
    assert h[2]["content"] == "*IMAGE*"
    assert all(isinstance(m["timestamp"], int) for m in h)


def test_history_trims_to_byte_cap_but_keeps_one():
    msgs = [_msg("in", "text", "x" * 500, 1000 + i) for i in range(50)]
    h = build_chat_history(msgs, max_messages=50, max_bytes=2000)
    assert len(h) >= 1
    assert len(h) < 50  # oldest dropped to fit the cap


# ── /generateResponse ──────────────────────────────────────────────────────────
def _client(responses, retry_delay=0.0):
    """responses: a list of (callable(request)->httpx.Response) OR Exception to raise, in order."""
    seq = iter(responses)

    def handler(request: httpx.Request) -> httpx.Response:
        item = next(seq)
        if isinstance(item, Exception):
            raise item
        return item(request)

    http = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    return CapitalClient("lic", http, base_url="https://api.capitalbot.ai", retry_delay=retry_delay)


def _ok(body):
    return lambda req: httpx.Response(200, json=body)


async def _gen(client, **kw):
    kw.setdefault("model_id", 1)
    kw.setdefault("preset_id", 2)
    kw.setdefault("account_id", "123")
    kw.setdefault("user_infos", {"useridentifier": "5"})
    kw.setdefault("chat_history", [{"role": "user", "content": "hi", "timestamp": 1}])
    return await client.generate_response(**kw)


async def test_parses_content_flags_and_conversation_id_from_statistics():
    body = {
        "content": [
            {"type": "text", "content": "hey!"},
            {"type": "image", "content": "https://x/pic.jpg", "mediaPool": "Primary"},
            {"type": "text", "content": ""},  # dropped (empty)
        ],
        "converted": False,
        "statistics": {"conversationId": 999},
    }
    r = await _gen(_client([_ok(body)]))
    assert [c.type for c in r.content] == ["text", "image"]
    assert r.content[1].media_pool == "Primary"
    assert r.conversation_id == 999
    assert r.stop_flag is None


async def test_stop_flag_resolution_and_cooldown():
    r = await _gen(_client([_ok({"content": [], "ignored": True})]))
    assert r.stop_flag == "ignored"
    r2 = await _gen(_client([_ok({"content": [], "chatCooldown": True, "chatCooldownUntil": 1782187200})]))
    assert r2.flag("chatCooldown") and r2.cooldown_until == 1782187200 and r2.stop_flag is None


async def test_429_is_retried_once_then_succeeds():
    client = _client([lambda req: httpx.Response(429), _ok({"content": [{"type": "text", "content": "ok"}]})])
    r = await _gen(client)
    assert r.has_content


async def test_dropped_connection_is_retried_once():
    client = _client([httpx.ConnectError("boom"), _ok({"content": []})])
    r = await _gen(client)
    assert r.content == []


async def test_timeout_is_not_retried():
    client = _client([httpx.ReadTimeout("slow")])  # only one response queued → no retry attempted
    with pytest.raises(CapitalError) as ei:
        await _gen(client)
    assert ei.value.kind == "timeout"


async def test_5xx_is_not_retried():
    client = _client([lambda req: httpx.Response(502)])
    with pytest.raises(CapitalError) as ei:
        await _gen(client)
    assert ei.value.kind == "server"


async def test_400_raises_with_pause():
    client = _client([lambda req: httpx.Response(400, json={"error": "bad preset"})])
    with pytest.raises(CapitalError) as ei:
        await _gen(client)
    assert ei.value.kind == "client" and ei.value.pause is True


async def test_media_upload_sends_multipart_with_file(tmp_path):
    seen = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["ctype"] = request.headers.get("content-type", "")
        seen["body"] = request.content
        return httpx.Response(200, json={"content": [{"type": "text", "content": "cute pic"}]})

    http = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    client = CapitalClient("lic", http, retry_delay=0.0)
    f = tmp_path / "pic.jpg"
    f.write_bytes(b"\xff\xd8jpeg")
    r = await _gen(client, file_path=str(f))
    assert r.has_content
    assert seen["ctype"].startswith("multipart/form-data")
    assert b'name="file"' in seen["body"] and b"chatHistory" in seen["body"]


async def test_catalog_shapes_and_caches():
    calls = {"n": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        calls["n"] += 1
        return httpx.Response(200, json={"success": True, "data": {"models": [{"modelId": 43, "name": "Lily"}], "presets": [{"id": 88, "name": "Flirty", "archived": 0}]}})

    http = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    client = CapitalClient("lic", http)
    cat = await client.catalog()
    assert cat["models"] == [{"id": 43, "name": "Lily"}]
    assert cat["presets"][0]["id"] == 88
    await client.catalog()  # cached
    assert calls["n"] == 1
