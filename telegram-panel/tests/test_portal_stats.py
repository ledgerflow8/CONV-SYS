"""The panel fetching the portal's current-week convo breakdown (item 4)."""

import asyncio

import httpx

from panel.portal import PortalConfig, fetch_week_stats


def test_fetch_week_stats_signs_empty_body_and_parses():
    cfg = PortalConfig("https://www.fansflow.site/api/ingest/convo", "key", "secret")
    seen = {}

    def handler(req):
        seen["url"] = str(req.url)
        seen["auth"] = req.headers.get("authorization")
        seen["sig"] = req.headers.get("x-signature")
        return httpx.Response(200, json={"counts": {"qualified": 3, "pending": 1, "rejected": 2, "review": 0}})

    async def _run():
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as c:
            return await fetch_week_stats(c, cfg)

    out = asyncio.run(_run())
    assert out["counts"]["qualified"] == 3
    assert seen["url"].endswith("/api/ingest/stats")  # derived from the convo URL
    assert seen["auth"] == "Bearer key"
    assert seen["sig"].startswith("sha256=")


def test_fetch_week_stats_none_when_unconfigured():
    async def _run():
        async with httpx.AsyncClient() as c:
            return await fetch_week_stats(c, PortalConfig(None, None, None))

    assert asyncio.run(_run()) is None


def test_fetch_week_stats_none_on_error_status():
    cfg = PortalConfig("https://www.fansflow.site/api/ingest/convo", "key", "secret")

    async def _run():
        async with httpx.AsyncClient(transport=httpx.MockTransport(lambda req: httpx.Response(401, json={"error": "nope"}))) as c:
            return await fetch_week_stats(c, cfg)

    assert asyncio.run(_run()) is None
