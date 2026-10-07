import { describe, expect, it } from "vitest";
import { parseSettingsForm, TIMEZONES, type SettingsFormInput } from "./settings-form";

const valid: SettingsFormInput = {
  rateVa: "0.25",
  rateLeadVa: "0.10",
  rateLm: "0",
  tier1Countries: "us, ca gb,AU nz ie, us",
  blockedDomains: "https://www.Spam.io/x\nold.example.com\n\n",
  timezone: "Etc/GMT-2",
  payoutCurrency: " USDT (TRC-20) ",
  clickMatchWindowMin: "30",
  supportTelegram: "@helpdesk_team",
};

describe("parseSettingsForm", () => {
  it("normalises a valid form", () => {
    expect(parseSettingsForm(valid)).toEqual({
      ok: true,
      settings: {
        rates: { va: 25, leadVa: 10, lm: 0 },
        tier1Countries: ["US", "CA", "GB", "AU", "NZ", "IE"],
        blockedDomains: ["spam.io", "old.example.com"],
        timezone: "Etc/GMT-2",
        payoutCurrency: "USDT (TRC-20)",
        clickMatchWindowMin: 30,
        supportTelegram: "helpdesk_team",
      },
    });
  });

  it("allows an empty support handle and empty blocked list", () => {
    const r = parseSettingsForm({ ...valid, supportTelegram: "", blockedDomains: "" });
    expect(r.ok && r.settings.supportTelegram).toBe("");
    expect(r.ok && r.settings.blockedDomains).toEqual([]);
  });

  it("reports every bad field", () => {
    const r = parseSettingsForm({
      ...valid,
      rateVa: "0.255",
      rateLm: "250",
      tier1Countries: "USA, ca",
      blockedDomains: "not a domain",
      timezone: "Europe/Lagos",
      payoutCurrency: "",
      clickMatchWindowMin: "0",
      supportTelegram: "ab",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(Object.keys(r.errors).sort()).toEqual(
        ["blockedDomains", "clickMatchWindowMin", "payoutCurrency", "rateLm", "rateVa", "supportTelegram", "tier1Countries", "timezone"].sort(),
      );
    }
  });

  it("offers only fixed-offset zones, including the default GMT+2", () => {
    expect(TIMEZONES).toContain("Etc/GMT-2");
    expect(TIMEZONES).toContain("UTC");
    expect(TIMEZONES.every((z) => z === "UTC" || /^Etc\/GMT[+-]\d{1,2}$/.test(z))).toBe(true);
  });
});
