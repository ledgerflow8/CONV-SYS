// Defaults from PLAN.md §1 and §9. Stored in the Setting table; editable by the Director.
export type Settings = {
  rates: { va: number; leadVa: number; lm: number }; // cents per qualified convo
  tier1Countries: string[];
  blockedDomains: string[];
  timezone: string;
  payoutCurrency: string;
  clickMatchWindowMin: number;
  supportTelegram: string; // handle for "Report a Problem"; empty = not set up yet
};

export const SETTING_DEFAULTS: Settings = {
  rates: { va: 25, leadVa: 10, lm: 0 },
  tier1Countries: ["US", "CA", "GB", "AU", "NZ", "IE"],
  blockedDomains: [],
  timezone: "Etc/GMT-2", // shown as "GMT +2"
  payoutCurrency: "USDT",
  clickMatchWindowMin: 30,
  supportTelegram: "",
};

export type SettingKey = keyof Settings;
