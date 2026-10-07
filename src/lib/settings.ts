import { db } from "@/lib/db";
import { SETTING_DEFAULTS, type SettingKey, type Settings } from "@/lib/settings-defaults";

export async function getSetting<K extends SettingKey>(key: K): Promise<Settings[K]> {
  const row = await db.setting.findUnique({ where: { key } });
  return (row?.value as Settings[K] | undefined) ?? SETTING_DEFAULTS[key];
}
