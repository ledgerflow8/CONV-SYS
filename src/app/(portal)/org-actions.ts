"use server";

// Fire / move team / fire-inactive actions, shared by the Director, Lead Manager and Lead VA pages.
// Who may do what is decided in src/lib/org.ts, not here.
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { fail, type Result } from "@/lib/action-result";
import { requireUser } from "@/lib/auth/session";
import {
  bulkMoveTeams,
  findInactiveVas,
  fireInactiveVas,
  fireUser,
  moveTeam,
  planBulkMove,
  planFire,
  planTeamMove,
  type FireOutcome,
  type FirePlan,
  type InactiveVa,
  type MoveOutcome,
  type MovePlan,
} from "@/lib/org";

const id = z.string().min(1).max(64);
const done = () => revalidatePath("/", "layout"); // dashboards, People, pool and Models all change

export async function planFireAction(targetId: unknown): Promise<Result<FirePlan>> {
  const actor = await requireUser();
  const p = id.safeParse(targetId);
  return p.success ? planFire(actor, p.data) : fail("Invalid request.");
}

export async function fireUserAction(targetId: unknown, reports: unknown): Promise<Result<FireOutcome>> {
  const actor = await requireUser();
  const p = z.tuple([id, z.union([z.literal("fire"), z.object({ moveTo: id }), z.null()])]).safeParse([targetId, reports]);
  if (!p.success) return fail("Invalid request.");
  const r = await fireUser(actor, p.data[0], p.data[1] ? { reports: p.data[1] } : {});
  done();
  return r;
}

export async function planTeamMoveAction(leadVaId: unknown, modelId: unknown): Promise<Result<MovePlan>> {
  const actor = await requireUser();
  const p = z.tuple([id, id]).safeParse([leadVaId, modelId]);
  return p.success ? planTeamMove(actor, ...p.data) : fail("Pick a model.");
}

export async function moveTeamAction(leadVaId: unknown, modelId: unknown, allowShort: unknown): Promise<Result<MoveOutcome>> {
  const actor = await requireUser();
  const p = z.tuple([id, id, z.boolean()]).safeParse([leadVaId, modelId, allowShort]);
  if (!p.success) return fail("Invalid request.");
  const r = await moveTeam(actor, p.data[0], p.data[1], { allowShort: p.data[2] });
  done();
  return r;
}

export async function planBulkMoveAction(fromModelId: unknown, toModelId: unknown): Promise<Result<MovePlan>> {
  const actor = await requireUser();
  const p = z.tuple([id, id]).safeParse([fromModelId, toModelId]);
  return p.success ? planBulkMove(actor, ...p.data) : fail("Pick a model.");
}

export async function bulkMoveAction(fromModelId: unknown, toModelId: unknown, allowShort: unknown): Promise<Result<MoveOutcome>> {
  const actor = await requireUser();
  const p = z.tuple([id, id, z.boolean()]).safeParse([fromModelId, toModelId, allowShort]);
  if (!p.success) return fail("Invalid request.");
  const r = await bulkMoveTeams(actor, p.data[0], p.data[1], { allowShort: p.data[2] });
  done();
  return r;
}

export async function findInactiveAction(days: unknown): Promise<Result<InactiveVa[]>> {
  const actor = await requireUser();
  const p = z.number().int().safeParse(days);
  return p.success ? findInactiveVas(actor, p.data) : fail("Pick a number of days.");
}

export async function fireInactiveAction(days: unknown, vaIds: unknown): Promise<Result<{ fired: number; skipped: number }>> {
  const actor = await requireUser();
  const p = z.tuple([z.number().int(), z.array(id).max(1000)]).safeParse([days, vaIds]);
  if (!p.success) return fail("Invalid request.");
  const r = await fireInactiveVas(actor, ...p.data);
  done();
  return r;
}
