import { describe, expect, it } from "vitest";
import {
  clientIp,
  countryFromHeaders,
  hashIp,
  isBlockedDomain,
  isPreviewBot,
  normalizeDomain,
  refDomainOf,
} from "./clicks";

const h = (o: Record<string, string>) => new Headers(o);

describe("countryFromHeaders", () => {
  it("reads Vercel's header", () => {
    expect(countryFromHeaders(h({ "x-vercel-ip-country": "us" }))).toBe("US");
  });

  it("reads Netlify's base64 JSON header", () => {
    const nf = Buffer.from(JSON.stringify({ country: { code: "GB", name: "United Kingdom" } })).toString("base64");
    expect(countryFromHeaders(h({ "x-nf-geo": nf }))).toBe("GB");
  });

  it("returns null for missing or junk values", () => {
    expect(countryFromHeaders(h({}))).toBeNull();
    expect(countryFromHeaders(h({ "x-vercel-ip-country": "USA" }))).toBeNull();
    expect(countryFromHeaders(h({ "x-nf-geo": "not-base64-json" }))).toBeNull();
  });
});

describe("refDomainOf", () => {
  it("lowercases and strips www", () => {
    expect(refDomainOf("https://www.Reddit.com/r/x?y=1")).toBe("reddit.com");
    expect(refDomainOf("http://old.reddit.com/")).toBe("old.reddit.com");
  });

  it("ignores non-http and junk", () => {
    expect(refDomainOf(null)).toBeNull();
    expect(refDomainOf("android-app://com.reddit")).toBeNull();
    expect(refDomainOf("not a url")).toBeNull();
  });
});

describe("normalizeDomain", () => {
  it("accepts bare domains and URLs", () => {
    expect(normalizeDomain(" Example.COM ")).toBe("example.com");
    expect(normalizeDomain("https://www.spam-site.io/path")).toBe("spam-site.io");
    expect(normalizeDomain("www.foo.co.uk/x")).toBe("foo.co.uk");
  });

  it("rejects things that aren't domains", () => {
    for (const bad of ["", "localhost", "foo", "*.foo.com", "foo..com", "-foo.com", "1.2.3.4"]) {
      expect(normalizeDomain(bad)).toBeNull();
    }
  });
});

describe("isBlockedDomain", () => {
  const list = ["reddit.com", "spam.io"];
  it("blocks exact matches and subdomains only", () => {
    expect(isBlockedDomain("reddit.com", list)).toBe(true);
    expect(isBlockedDomain("old.reddit.com", list)).toBe(true);
    expect(isBlockedDomain("notreddit.com", list)).toBe(false);
    expect(isBlockedDomain("reddit.com.evil.net", list)).toBe(false);
    expect(isBlockedDomain(null, list)).toBe(false);
  });
});

describe("clientIp / hashIp", () => {
  it("takes the first forwarded address", () => {
    expect(clientIp(h({ "x-forwarded-for": "203.0.113.7, 10.0.0.1" }))).toBe("203.0.113.7");
    expect(clientIp(h({ "x-real-ip": "198.51.100.2" }))).toBe("198.51.100.2");
    expect(clientIp(h({}))).toBeNull();
  });

  it("never returns the raw IP and depends on the salt", () => {
    const a = hashIp("203.0.113.7", "salt-a");
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).not.toContain("203.0.113.7");
    expect(hashIp("203.0.113.7", "salt-b")).not.toBe(a);
    expect(hashIp("203.0.113.7", undefined)).toBeNull();
  });
});

describe("isPreviewBot", () => {
  it("flags link-preview fetchers and missing UAs", () => {
    expect(isPreviewBot("TelegramBot (like TwitterBot)")).toBe(true);
    expect(isPreviewBot("WhatsApp/2.23.20.0")).toBe(true);
    expect(isPreviewBot("facebookexternalhit/1.1")).toBe(true);
    expect(isPreviewBot(null)).toBe(true);
  });

  it("lets real browsers through", () => {
    expect(
      isPreviewBot("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1"),
    ).toBe(false);
    expect(isPreviewBot("Mozilla/5.0 (Linux; Android 14) Chrome/126.0 Mobile Safari/537.36")).toBe(false);
  });
});
