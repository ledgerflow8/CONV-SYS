import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { getAllSettings, saveSettings } from "@/lib/settings";
import { asActor, makeUser, resetDb } from "../../test/fixtures";

beforeEach(resetDb);

describe("saveSettings", () => {
  it("only reports (and audits) keys whose values actually changed, whatever order Postgres stored them in", async () => {
    const director = asActor(await makeUser("DIRECTOR", null));
    const s = await getAllSettings();

    // Same values, keys in a different order than stored.
    const same = await saveSettings(director, { ...s, rates: { lm: s.rates.lm, leadVa: s.rates.leadVa, va: s.rates.va } });
    expect(same.ok && same.data.changed).toEqual([]);

    const changed = await saveSettings(director, { ...s, tier1Countries: [...s.tier1Countries, "DE"] });
    expect(changed.ok && changed.data.changed).toEqual(["tier1Countries"]);
    expect(await db.auditLog.count({ where: { action: "setting.update" } })).toBe(1);
  });
});
