// Login input clean-up. Credentials usually travel by copy-paste through Telegram, which adds
// stray spaces, line breaks, zero-width characters, and people prefix usernames with "@".
// Pure: safe to unit-test and to import anywhere.

const INVISIBLE = /[​-‍⁠﻿­]/g;

/** " @Teddyalte_LM​ " → "Teddyalte_LM" */
export function cleanUsername(input: string): string {
  return input.replace(INVISIBLE, "").trim().replace(/^@+/, "").trim();
}

/**
 * Generated passwords are letters and digits only (src/lib/auth/password.ts), so any whitespace or
 * invisible character in what was typed is a copy artefact and is removed.
 */
export function cleanPassword(input: string): string {
  return input.replace(INVISIBLE, "").replace(/\s+/g, "");
}

const SUFFIXES = ["_LM", "_LVA", "_VA"] as const;

/** Usernames to try when someone types their Telegram handle without the role suffix. */
export function suffixCandidates(username: string): string[] {
  return SUFFIXES.some((s) => username.toUpperCase().endsWith(s)) ? [] : SUFFIXES.map((s) => `${username}${s}`);
}
