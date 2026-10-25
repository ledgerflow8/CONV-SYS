// Defaults from PLAN.md §1 and §9. Stored in the Setting table; editable by the Director.
export type Settings = {
  rates: { va: number; leadVa: number; lm: number }; // cents per qualified convo
  tier1Countries: string[];
  blockedDomains: string[];
  timezone: string;
  payoutCurrency: string;
  clickMatchWindowMin: number;
  supportTelegram: string; // handle for "Report a Problem"; empty = not set up yet
  leaderboardPrizes: { va: number[]; leadVa: number[] }; // cents for 1st, 2nd, 3rd; paid at week lock
  leaderboardMinConvos: { va: number[]; leadVa: number[] }; // qualified convos needed for 1st, 2nd, 3rd
  leaderboardPassDown: boolean; // unmet minimum: false = prize not paid; true = next qualifying person gets it
};

export const SETTING_DEFAULTS: Settings = {
  rates: { va: 25, leadVa: 10, lm: 0 },
  tier1Countries: ["US", "CA", "GB", "AU", "NZ", "IE", "GG", "JE", "IM", "DE", "NO", "FI", "FR"],
  blockedDomains: [],
  timezone: "Etc/GMT-2", // shown as "GMT +2"
  payoutCurrency: "USDT",
  clickMatchWindowMin: 30,
  supportTelegram: "",
  leaderboardPrizes: { va: [1000, 800, 500], leadVa: [3000, 1000, 500] },
  leaderboardMinConvos: { va: [200, 200, 200], leadVa: [500, 0, 0] },
  leaderboardPassDown: false,
};

export type SettingKey = keyof Settings;
