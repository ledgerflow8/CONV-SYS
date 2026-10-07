import { describe, expect, it } from "vitest";
import { parseConvoCsv, parseCsv } from "./csv";

describe("parseCsv", () => {
  it("handles quotes, escaped quotes, embedded commas/newlines, CRLF and BOM", () => {
    const text = '﻿a,b,c\r\n"x, y","say ""hi""","multi\nline"\r\n\r\n1,,3';
    expect(parseCsv(text)).toEqual([
      ["a", "b", "c"],
      ["x, y", 'say "hi"', "multi\nline"],
      ["1", "", "3"],
    ]);
  });
});

describe("parseConvoCsv", () => {
  it("maps snake_case and camelCase headers in any order, with line numbers", () => {
    const r = parseConvoCsv("peerId,first_msg_at,TG_ACCOUNT,replied_at\n123,2026-10-07T10:00:00Z,@acct,\n");
    expect(r).toEqual({
      rows: [
        {
          line: 2,
          event: { tgAccount: "@acct", peerId: "123", peerPhone: undefined, firstMsgAt: "2026-10-07T10:00:00Z", repliedAt: undefined, source: undefined },
        },
      ],
    });
  });

  it("reports missing required columns", () => {
    const r = parseConvoCsv("tg_account,peer_phone\na,+1");
    expect("error" in r && r.error).toMatch(/peer_id, first_msg_at/);
  });
});
