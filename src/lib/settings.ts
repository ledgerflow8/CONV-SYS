import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { audit } from "@/lib/audit";
import { fail, type Result } from "@/lib/action-result";
import type { CurrentUser } from "@/lib/auth/session";
import { SETTING_DEFAULTS, type SettingKey, type Settings } from "@/lib/settings-defaults";

export async function getSetting<K extends SettingKey>(key: K): Promise<Settings[K]> {
  const row = await db.setting.findUnique({ where: { key } });
  return (row?.value as Settings[K] | undefined) ?? SETTING_DEFAULTS[key];
}

export async function getAllSettings(): Promise<Settings> {
  const rows = await db.setting.findMany();
  const stored = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  return { ...SETTING_DEFAULTS, ...stored } as Settings;
}

/** Saves the changed keys in one transaction and audits before/after for each. */
export async function saveSettings(actor: CurrentUser, next: Settings): Promise<Result<{ changed: SettingKey[] }>> {
  if (actor.role !== "DIRECTOR") return fail("Only the Director can change settings.");

  const changed = await db.$transaction(async (tx) => {
    const current = { ...SETTING_DEFAULTS, ...Object.fromEntries((await tx.setting.findMany()).map((r) => [r.key, r.value])) } as Settings;
    const keys = (Object.keys(next) as SettingKey[]).filter((k) => JSON.stringify(current[k]) !== JSON.stringify(next[k]));
    for (const key of keys) {
      const value = next[key] as Prisma.InputJsonValue;
      await tx.setting.upsert({ where: { key }, update: { value }, create: { key, value } });
      await audit(tx, {
        actorId: actor.id,
        action: "setting.update",
        target: key,
        meta: { before: current[key] as Prisma.InputJsonValue, after: value },
      });
    }
    return keys;
  });
  return { ok: true, data: { changed } };
}
