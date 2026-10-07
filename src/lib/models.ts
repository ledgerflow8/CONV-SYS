import { db } from "@/lib/db";
import { audit } from "@/lib/audit";
import { fail, isUniqueViolation, type Result } from "@/lib/action-result";
import type { CurrentUser } from "@/lib/auth/session";

export async function createModel(actor: CurrentUser, rawName: string): Promise<Result<{ id: string }>> {
  if (actor.role !== "DIRECTOR") return fail("Only the Director can add models.");
  const name = rawName.trim().replace(/\s+/g, " ");
  if (name.length < 1 || name.length > 40) return fail("Model name must be 1–40 characters.");

  try {
    const id = await db.$transaction(async (tx) => {
      const exists = await tx.model.findFirst({ where: { name: { equals: name, mode: "insensitive" } } });
      if (exists) throw new NameTaken();
      const model = await tx.model.create({ data: { name } });
      await audit(tx, { actorId: actor.id, action: "model.create", target: model.id, meta: { name } });
      return model.id;
    });
    return { ok: true, data: { id } };
  } catch (e) {
    if (e instanceof NameTaken || isUniqueViolation(e)) return fail(`A model called "${name}" already exists.`);
    throw e;
  }
}

class NameTaken extends Error {}

export async function setModelActive(actor: CurrentUser, modelId: string, active: boolean): Promise<Result<null>> {
  if (actor.role !== "DIRECTOR") return fail("Only the Director can change models.");
  const model = await db.model.findUnique({ where: { id: modelId } });
  if (!model) return fail("Model not found.");
  if (model.active === active) return { ok: true, data: null };

  await db.$transaction(async (tx) => {
    await tx.model.update({ where: { id: modelId }, data: { active } });
    await audit(tx, { actorId: actor.id, action: active ? "model.activate" : "model.deactivate", target: modelId });
  });
  return { ok: true, data: null };
}
