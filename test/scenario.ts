// Shared randomised org + event stream for database tests (invariants, stats).
import type { Role } from "@prisma/client";
import { assign, makeAccount, makeModel, makeUser } from "./fixtures";

const DAY = 24 * 3600_000;

// Deterministic PRNG so a failure is reproducible.
export function rng(seed: number) {
  return () => {
    seed = (seed * 1664525 + 1013904223) % 2 ** 32;
    return seed / 2 ** 32;
  };
}

export type Person = { id: string; role: Role; modelId: string | null; parentId: string | null };
export type Org = { director: Person; lms: Person[]; lvas: Person[]; vas: Person[]; accounts: { id: string; username: string; vaId: string }[] };

export async function buildOrg(): Promise<Org> {
  const models = [await makeModel(), await makeModel()];
  const director = await makeUser("DIRECTOR", null);
  const org: Org = { director, lms: [], lvas: [], vas: [], accounts: [] };
  for (let l = 0; l < 2; l++) {
    const lm = await makeUser("LEAD_MANAGER", director.id);
    org.lms.push(lm);
    for (let t = 0; t < 2; t++) {
      const model = models[t];
      const lva = await makeUser("LEAD_VA", lm.id, model.id);
      org.lvas.push(lva);
      for (let v = 0; v < 3; v++) {
        const va = await makeUser("VA", lva.id, model.id);
        org.vas.push(va);
        const acct = await makeAccount(model.id);
        await assign(acct.id, va.id, new Date(Date.now() - 30 * DAY));
        org.accounts.push({ id: acct.id, username: acct.username, vaId: va.id });
      }
    }
  }
  return org;
}

export const PHONES = ["+14155550100", "+16475550100", "+447400123456", "+61412345678", "+353851234567", "+2348031234567", "+919812345678", null, null];

export function events(org: Org, count: number, rand: () => number, window: { from: number; to: number }) {
  const out: Record<string, unknown>[] = [];
  for (let i = 0; i < count; i++) {
    const acct = org.accounts[Math.floor(rand() * org.accounts.length)];
    const first = window.from + rand() * (window.to - window.from - 3600_000);
    const replied = rand() < 0.8 ? first + rand() * 3000_000 : null;
    const e = {
      tgAccount: acct.username,
      peerId: `peer${Math.floor(rand() * count * 0.7)}`, // ~30% collide → repeat events
      peerPhone: PHONES[Math.floor(rand() * PHONES.length)],
      firstMsgAt: new Date(first).toISOString(),
      ...(replied ? { repliedAt: new Date(Math.min(replied, Date.now() - 1000)).toISOString() } : {}),
    };
    out.push(e);
    if (rand() < 0.2) out.push({ ...e }); // exact duplicate delivery
  }
  // shuffle: events don't arrive in order
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

