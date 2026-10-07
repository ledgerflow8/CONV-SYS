import { describe, expect, it } from "vitest";
import { normalizeAccountLink, parsePoolImport, validatePoolRow } from "./pool-import";

describe("validatePoolRow", () => {
  it("normalizes username, phone and default link", () => {
    expect(validatePoolRow({ username: "@SophieJetlag", phone: "+1 (309) 555-0100" })).toEqual({
      row: { username: "sophiejetlag", phone: "+13095550100", link: "https://t.me/sophiejetlag" },
    });
  });

  it("rejects bad phones and non-t.me links", () => {
    expect(validatePoolRow({ username: "sophiejetlag", phone: "3095550100" })).toHaveProperty("error");
    expect(validatePoolRow({ username: "sophiejetlag", phone: "+13095550100", link: "https://evil.com/x" })).toHaveProperty(
      "error",
    );
  });
});

describe("normalizeAccountLink", () => {
  it("only accepts https t.me links", () => {
    expect(normalizeAccountLink("https://t.me/abcde", "abcde")).toBe("https://t.me/abcde");
    expect(normalizeAccountLink("http://t.me/abcde", "abcde")).toBeNull();
    expect(normalizeAccountLink("https://t.me.evil.com/abcde", "abcde")).toBeNull();
    expect(normalizeAccountLink("javascript:alert(1)", "abcde")).toBeNull();
    expect(normalizeAccountLink("https://t.me/", "abcde")).toBeNull();
  });
});

describe("parsePoolImport", () => {
  it("parses mixed separators, skips header and blank lines", () => {
    const { rows, rejects } = parsePoolImport(
      ["username,phone,link", "acct_one,+13095550101", "", "acct_two\t+447700900123", "acct_three;+61491570156;https://t.me/acct_three"].join(
        "\n",
      ),
    );
    expect(rejects).toEqual([]);
    expect(rows.map((r) => [r.line, r.row.username])).toEqual([
      [2, "acct_one"],
      [4, "acct_two"],
      [5, "acct_three"],
    ]);
  });

  it("rejects case-insensitive duplicates within the paste and reports line numbers", () => {
    const { rows, rejects } = parsePoolImport("acct_one,+13095550101\nACCT_ONE,+13095550102\nbad,+1309");
    expect(rows).toHaveLength(1);
    expect(rejects).toEqual([
      { line: 2, raw: "ACCT_ONE,+13095550102", reason: "duplicate in this import" },
      { line: 3, raw: "bad,+1309", reason: "invalid username" },
    ]);
  });
});
