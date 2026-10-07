// Defaults from PLAN.md §1 and §9. Stored in the Setting table; editable by the Director.
export const SETTING_DEFAULTS = {
  rates: { va: 25, leadVa: 10, lm: 0 }, // cents per qualified convo
  tier1Countries: ["US", "CA", "GB", "AU", "NZ", "IE"],
  blockedDomains: [] as string[],
  timezone: "Etc/GMT-2", // shown as "GMT +2"
  payoutCurrency: "USDT",
  clickMatchWindowMin: 30,
} as const;

export type SettingKey = keyof typeof SETTING_DEFAULTS;
