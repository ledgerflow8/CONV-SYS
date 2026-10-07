"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { fail, type Result } from "@/lib/action-result";
import { requireRole } from "@/lib/auth/session";
import { createManagedUser, regeneratePassword, type Credentials } from "@/lib/people";

export async function createLeadVaAction(input: unknown): Promise<Result<Credentials>> {
  const actor = await requireRole("LEAD_MANAGER");
  const parsed = z.object({ handle: z.string().max(64), modelId: z.string().min(1).max(64) }).safeParse(input);
  if (!parsed.success) return fail("Enter a Telegram username and pick a model.");
  const result = await createManagedUser(actor, { role: "LEAD_VA", ...parsed.data });
  revalidatePath("/lead-manager");
  return result;
}

export async function regenerateLeadVaPasswordAction(userId: unknown): Promise<Result<Credentials>> {
  const actor = await requireRole("LEAD_MANAGER");
  const parsed = z.string().min(1).max(64).safeParse(userId);
  if (!parsed.success) return fail("Invalid request.");
  return regeneratePassword(actor, parsed.data);
}
