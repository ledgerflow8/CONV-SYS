import { beforeEach, describe, expect, it } from "vitest";
import { ingestConvoEvent } from "@/lib/ingest";
import { signIngestBody } from "@/lib/ingest-auth";
import { makeTeam, minutesAgo, resetDb, setSetting } from "../../../../../test/fixtures";
import { GET } from "./route";

const KEY = "panel-key";
const SECRET = "panel-secret";

beforeEach(async () => {
  await resetDb();
  process.env.INGEST_API_KEY = KEY;
  process.env.INGEST_HMAC_SECRET = SECRET;
});

function signedRequest(sig?: string) {
  const ts = String(Math.floor(Date.now() / 1000));
  return new Request("https://portal.example/api/ingest/stats", {
    method: "GET",
    headers: {
      authorization: `Bearer ${KEY}`,
      "x-timestamp": ts,
      "x-signature": sig ?? signIngestBody(SECRET, ts, ""),
    },
  });
}

describe("GET /api/ingest/stats", () => {
  it("returns the current-week breakdown; qualified matches the dashboard's inWeek", async () => {
    await setSetting("timezone", "Etc/GMT-2");
    const t = await makeTeam();
    await ingestConvoEvent(
      { tgAccount: t.account.username, peerId: "p", peerPhone: "+14155550100", firstMsgAt: minutesAgo(30).toISOString(), repliedAt: minutesAgo(2).toISOString() },
      { via: "api" },
    );
    const res = await GET(signedRequest());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.counts.qualified).toBe(1);
    expect(body.counts.pending).toBe(0);
    expect(body.week.startsAt).toBeTruthy();
    expect(body.timezone).toBe("Etc/GMT-2");
  });

  it("rejects a bad signature with 401", async () => {
    const res = await GET(signedRequest("sha256=deadbeef"));
    expect(res.status).toBe(401);
  });
});
