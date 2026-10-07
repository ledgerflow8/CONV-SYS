// Lead VA team management (PLAN.md §5): Add VA, regenerate invite, Fire VA.
import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { audit } from "@/lib/audit";
import { fail, isUniqueViolation, type Result } from "@/lib/action-result";
import { generatePassword, hashPassword, setPassword } from "@/lib/auth/password";
import type { CurrentUser } from "@/lib/auth/session";
import { encrypt, hashToken, newInviteToken, randomSlug } from "@/lib/crypto";
import { botInviteUrl } from "@/lib/links";
import { normalizeHandle } from "@/lib/telegram";
import { portalUsername } from "@/lib/usernames";

export const INVITE_TTL_MS = 72 * 60 * 60 * 1000;
export const EMPTY_POOL_MESSAGE = "No Telegram accounts left for this model. Ask your Director to add more.";

export type Invite = { username: string; token: string; url: string | null; expiresAt: Date; rehired: boolean };

class Abort extends Error {}

/** Locks and returns the next available account for a model, or null. Must run inside a transaction. */
async function claimAvailableAccount(tx: Prisma.TransactionClient, modelId: string) {
  const rows = await tx.$queryRaw<{ id: string; username: string }[]>`
    SELECT id, username FROM "TgAccount"
    WHERE "modelId" = ${modelId} AND status = 'AVAILABLE'
    ORDER BY "createdAt", username
    LIMIT 1
    FOR UPDATE SKIP LOCKED`;
  return rows[0] ?? null;
}

/** Issues a fresh one-time invite carrying the encrypted password; voids any earlier unused ones. */
async function issueInvite(tx: Prisma.TransactionClient, userId: string, password: string) {
  await tx.inviteToken.updateMany({
    where: { userId, usedAt: null },
    data: { expiresAt: new Date(), passwordEnc: null },
  });
  const token = newInviteToken();
  const expiresAt = new Date(Date.now() + INVITE_TTL_MS);
  await tx.inviteToken.create({
    data: { tokenHash: hashToken(token), userId, passwordEnc: encrypt(password), expiresAt },
  });
  return { token, expiresAt };
}

export async function addVa(actor: CurrentUser, rawHandle: string): Promise<Result<Invite>> {
  if (actor.role !== "LEAD_VA") return fail("Only Lead VAs can add VAs.");
  if (!actor.modelId) return fail("Your team has no model yet. Ask your Lead Manager.");

  const handle = normalizeHandle(rawHandle);
  const username = portalUsername(rawHandle, "VA");
  if (!handle || !username) {
    return fail("Telegram username must be 5–32 letters, numbers or underscores, starting with a letter.");
  }

  const password = generatePassword();
  const passwordHash = await hashPassword(password);

  try {
    const invite = await db.$transaction(async (tx) => {
      const existing = await tx.user.findFirst({
        where: { username: { equals: username, mode: "insensitive" } },
        select: { id: true, username: true, role: true, status: true },
      });
      const rehire = existing?.role === "VA" && existing.status === "FIRED";
      if (existing && !rehire) throw new Abort(`@${existing.username} is already taken.`);

      const account = await claimAvailableAccount(tx, actor.modelId!);
      if (!account) throw new Abort(EMPTY_POOL_MESSAGE);

      let vaId: string;
      if (rehire) {
        // Reactivate the fired VA under this team. Conditional on FIRED so two Lead VAs
        // re-hiring the same person at once can't both win.
        const reactivated = await tx.user.updateMany({
          where: { id: existing.id, status: "FIRED" },
          data: {
            status: "ACTIVE",
            firedAt: null,
            parentId: actor.id,
            modelId: actor.modelId,
            telegramHandle: handle,
            passwordHash,
            sessionVersion: { increment: 1 },
            // Whoever opens the new invite gets linked; the old binding may be a different person.
            telegramUserId: null,
          },
        });
        if (reactivated.count === 0) throw new Abort(`@${existing.username} was just re-hired by someone else.`);
        vaId = existing.id;
        // Tracking links survive: same slug as before, switched back on.
        await tx.trackingLink.upsert({
          where: { vaId },
          update: { active: true },
          create: { vaId, slug: randomSlug() },
        });
      } else {
        const va = await tx.user.create({
          data: {
            username,
            passwordHash,
            role: "VA",
            parentId: actor.id,
            createdById: actor.id,
            modelId: actor.modelId,
            telegramHandle: handle,
          },
        });
        vaId = va.id;
        await tx.trackingLink.create({ data: { vaId, slug: randomSlug() } });
      }

      await tx.tgAccount.update({ where: { id: account.id }, data: { status: "ASSIGNED", vaId } });
      await tx.tgAssignment.create({ data: { tgAccountId: account.id, vaId } });
      const { token, expiresAt } = await issueInvite(tx, vaId, password);
      await audit(tx, {
        actorId: actor.id,
        action: rehire ? "va.rehire" : "va.add",
        target: vaId,
        meta: { username, tgAccountId: account.id, tgAccount: account.username },
      });
      return { username: existing?.username ?? username, token, expiresAt, rehired: rehire };
    });
    return { ok: true, data: { ...invite, url: botInviteUrl(invite.token) } };
  } catch (e) {
    if (e instanceof Abort) return fail(e.message);
    if (isUniqueViolation(e)) return fail(`@${username} is already taken.`);
    throw e;
  }
}

/** New password + new invite link. The old link and any open sessions stop working. */
export async function regenerateInvite(actor: CurrentUser, vaId: string): Promise<Result<Invite>> {
  if (actor.role !== "LEAD_VA") return fail("Only Lead VAs can do this.");
  const va = await db.user.findFirst({
    where: { id: vaId, role: "VA", status: "ACTIVE", parentId: actor.id },
    select: { id: true, username: true },
  });
  if (!va) return fail("VA not found.");

  const password = generatePassword();
  const { token, expiresAt } = await db.$transaction(async (tx) => {
    await setPassword(tx, va.id, password);
    const invite = await issueInvite(tx, va.id, password);
    await audit(tx, { actorId: actor.id, action: "va.invite_regenerate", target: va.id });
    return invite;
  });
  return { ok: true, data: { username: va.username, token, url: botInviteUrl(token), expiresAt, rehired: false } };
}

/**
 * Fire: login blocked, tracking link off, assignment ended, account back to the pool.
 * Convos already earned in the open week still pay out (they keep their snapshotted vaId).
 */
export async function fireVa(actor: CurrentUser, vaId: string): Promise<Result<null>> {
  if (actor.role !== "LEAD_VA") return fail("Only Lead VAs can fire VAs.");

  try {
    await db.$transaction(async (tx) => {
      // Conditional update doubles as the authorisation check and makes double-fires a no-op.
      const fired = await tx.user.updateMany({
        where: { id: vaId, role: "VA", status: "ACTIVE", parentId: actor.id },
        data: { status: "FIRED", firedAt: new Date(), sessionVersion: { increment: 1 } },
      });
      if (fired.count === 0) throw new Abort("VA not found.");

      await tx.trackingLink.updateMany({ where: { vaId }, data: { active: false } });
      await tx.inviteToken.updateMany({
        where: { userId: vaId, usedAt: null },
        data: { expiresAt: new Date(), passwordEnc: null },
      });

      const account = await tx.tgAccount.findUnique({ where: { vaId }, select: { id: true, status: true } });
      if (account) {
        await tx.tgAssignment.updateMany({
          where: { tgAccountId: account.id, vaId, endedAt: null },
          data: { endedAt: new Date(), endReason: "fired" },
        });
        // A banned account stays banned; only a healthy one goes back to the pool.
        await tx.tgAccount.update({
          where: { id: account.id },
          data: { vaId: null, ...(account.status === "ASSIGNED" ? { status: "AVAILABLE" } : {}) },
        });
      }
      await audit(tx, { actorId: actor.id, action: "va.fire", target: vaId, meta: { tgAccountId: account?.id ?? null } });
    });
    return { ok: true, data: null };
  } catch (e) {
    if (e instanceof Abort) return fail(e.message);
    throw e;
  }
}
