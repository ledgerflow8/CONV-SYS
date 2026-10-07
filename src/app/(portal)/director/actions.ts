"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { fail, type Result } from "@/lib/action-result";
import { requireRole } from "@/lib/auth/session";
import { createModel, setModelActive } from "@/lib/models";
import { createManagedUser, regeneratePassword, setLeadManagerStatus, type Credentials } from "@/lib/people";
import { addPoolAccount, importPoolAccounts, type ImportSummary } from "@/lib/pool";

const id = z.string().min(1).max(64);

// ── Models ────────────────────────────────────────────────────────────────

export async function createModelAction(name: unknown): Promise<Result<{ id: string }>> {
  const actor = await requireRole("DIRECTOR");
  const parsed = z.string().max(100).safeParse(name);
  if (!parsed.success) return fail("Enter a model name.");
  const result = await createModel(actor, parsed.data);
  revalidatePath("/director/models");
  return result;
}

export async function setModelActiveAction(modelId: unknown, active: unknown): Promise<Result<null>> {
  const actor = await requireRole("DIRECTOR");
  const parsed = z.tuple([id, z.boolean()]).safeParse([modelId, active]);
  if (!parsed.success) return fail("Invalid request.");
  const result = await setModelActive(actor, ...parsed.data);
  revalidatePath("/director/models");
  revalidatePath("/director/pool");
  return result;
}

// ── Telegram Pool ─────────────────────────────────────────────────────────

const accountInput = z.object({
  modelId: id,
  username: z.string().max(64),
  phone: z.string().max(32),
  link: z.string().max(200).optional(),
});

export async function addPoolAccountAction(input: unknown): Promise<Result<{ id: string }>> {
  const actor = await requireRole("DIRECTOR");
  const parsed = accountInput.safeParse(input);
  if (!parsed.success) return fail("Fill in model, username and phone.");
  const result = await addPoolAccount(actor, parsed.data);
  revalidatePath("/director/pool");
  return result;
}

export async function importPoolAction(input: unknown): Promise<Result<ImportSummary>> {
  const actor = await requireRole("DIRECTOR");
  const parsed = z.object({ modelId: id, text: z.string().max(200_000) }).safeParse(input);
  if (!parsed.success) return fail("Pick a model and paste some accounts.");
  const result = await importPoolAccounts(actor, parsed.data);
  revalidatePath("/director/pool");
  return result;
}

// ── People ────────────────────────────────────────────────────────────────

export async function createLeadManagerAction(input: unknown): Promise<Result<Credentials>> {
  const actor = await requireRole("DIRECTOR");
  const parsed = z.object({ handle: z.string().max(64) }).safeParse(input);
  if (!parsed.success) return fail("Enter a Telegram username.");
  const result = await createManagedUser(actor, { role: "LEAD_MANAGER", handle: parsed.data.handle });
  revalidatePath("/director/people");
  return result;
}

export async function regeneratePasswordAction(userId: unknown): Promise<Result<Credentials>> {
  const actor = await requireRole("DIRECTOR");
  const parsed = id.safeParse(userId);
  if (!parsed.success) return fail("Invalid request.");
  return regeneratePassword(actor, parsed.data);
}

export async function setLeadManagerStatusAction(userId: unknown, status: unknown): Promise<Result<null>> {
  const actor = await requireRole("DIRECTOR");
  const parsed = z.tuple([id, z.enum(["ACTIVE", "DISABLED"])]).safeParse([userId, status]);
  if (!parsed.success) return fail("Invalid request.");
  const result = await setLeadManagerStatus(actor, ...parsed.data);
  revalidatePath("/director/people");
  return result;
}
