// Top-down account creation and password regeneration for Lead Managers and Lead VAs.
// VAs are created through the Add VA flow (Block 4) and get passwords via the bot only.
import type { Role } from "@prisma/client";
import { db } from "@/lib/db";
import { audit } from "@/lib/audit";
import { fail, isUniqueViolation, type Result } from "@/lib/action-result";
import { generatePassword, hashPassword, setPassword } from "@/lib/auth/password";
import type { CurrentUser } from "@/lib/auth/session";
import { normalizeHandle } from "@/lib/telegram";
import { portalUsername } from "@/lib/usernames";

// `reactivated`: the handle belonged to someone who was fired; their login was brought back instead.
export type Credentials = { username: string; password: string; model: string | null; reactivated?: boolean };

// Who may create whom: Director → Lead Manager, Lead Manager → Lead VA.
const CREATES: Partial<Record<Role, Role>> = { DIRECTOR: "LEAD_MANAGER", LEAD_MANAGER: "LEAD_VA" };

export async function createManagedUser(
  actor: CurrentUser,
  input: { role: Role; handle: string; modelId?: string },
): Promise<Result<Credentials>> {
  if (CREATES[actor.role] !== input.role) return fail("You can't create this kind of account.");

  const handle = normalizeHandle(input.handle);
  const username = portalUsername(input.handle, input.role);
  if (!handle || !username) {
    return fail("Telegram username must be 5–32 letters, numbers or underscores, starting with a letter.");
  }

  let model: { id: string; name: string } | null = null;
  if (input.role === "LEAD_VA") {
    if (!input.modelId) return fail("Pick a model for this team.");
    model = await db.model.findFirst({ where: { id: input.modelId, active: true }, select: { id: true, name: true } });
    if (!model) return fail("That model isn't available.");
  }

  const password = generatePassword();
  const passwordHash = await hashPassword(password);

  let result: { username: string; reactivated: boolean };
  try {
    result = await db.$transaction(async (tx) => {
      const existing = await tx.user.findFirst({
        where: { username: { equals: username, mode: "insensitive" } },
        select: { id: true, username: true, role: true, status: true },
      });

      // A fired person's handle doesn't block them coming back: reactivate the same login under
      // the new manager (new password; their old sessions were already ended when they were fired).
      if (existing?.status === "FIRED" && existing.role === input.role) {
        const r = await tx.user.updateMany({
          where: { id: existing.id, status: "FIRED" },
          data: {
            status: "ACTIVE",
            firedAt: null,
            parentId: actor.id,
            modelId: model?.id ?? null,
            telegramHandle: handle,
            passwordHash,
            sessionVersion: { increment: 1 },
          },
        });
        if (r.count === 0) throw new UsernameTaken();
        await audit(tx, {
          actorId: actor.id,
          action: "user.reactivate",
          target: existing.id,
          meta: { username: existing.username, role: input.role, modelId: model?.id ?? null },
        });
        return { username: existing.username, reactivated: true };
      }
      if (existing?.status === "DISABLED") throw new Disabled(existing.username);
      if (existing) throw new UsernameTaken();

      const user = await tx.user.create({
        data: {
          username,
          passwordHash,
          role: input.role,
          parentId: actor.id,
          createdById: actor.id,
          telegramHandle: handle,
          modelId: model?.id,
        },
      });
      await audit(tx, {
        actorId: actor.id,
        action: "user.create",
        target: user.id,
        meta: { username, role: input.role, modelId: model?.id ?? null },
      });
      return { username, reactivated: false };
    });
  } catch (e) {
    if (e instanceof Disabled) return fail(`${e.message} exists but is disabled. Enable it in People instead.`);
    if (e instanceof UsernameTaken || isUniqueViolation(e)) return fail(`${username} is already taken.`);
    throw e;
  }

  return { ok: true, data: { username: result.username, password, model: model?.name ?? null, reactivated: result.reactivated } };
}

class Disabled extends Error {}

class UsernameTaken extends Error {}

/** Director can regenerate any Lead Manager or Lead VA; a creator can regenerate their direct reports. */
export async function regeneratePassword(
  actor: CurrentUser,
  targetId: string,
): Promise<Result<Credentials>> {
  const target = await db.user.findUnique({
    where: { id: targetId },
    select: { id: true, username: true, role: true, parentId: true, model: { select: { name: true } } },
  });
  if (!target || (target.role !== "LEAD_MANAGER" && target.role !== "LEAD_VA")) return fail("User not found.");
  const allowed = actor.role === "DIRECTOR" || target.parentId === actor.id;
  if (!allowed) return fail("User not found.");

  const password = generatePassword();
  await db.$transaction(async (tx) => {
    await setPassword(tx, target.id, password);
    await audit(tx, { actorId: actor.id, action: "user.password_regenerate", target: target.id });
  });

  return { ok: true, data: { username: target.username, password, model: target.model?.name ?? null } };
}

export async function setLeadManagerStatus(
  actor: CurrentUser,
  targetId: string,
  status: "ACTIVE" | "DISABLED",
): Promise<Result<null>> {
  if (actor.role !== "DIRECTOR") return fail("Only the Director can do this.");
  const target = await db.user.findUnique({ where: { id: targetId }, select: { role: true, status: true } });
  if (!target || target.role !== "LEAD_MANAGER") return fail("Lead Manager not found.");
  if (target.status === status) return { ok: true, data: null };

  await db.$transaction(async (tx) => {
    await tx.user.update({ where: { id: targetId }, data: { status } });
    await audit(tx, { actorId: actor.id, action: `user.${status === "ACTIVE" ? "enable" : "disable"}`, target: targetId });
  });
  return { ok: true, data: null };
}
