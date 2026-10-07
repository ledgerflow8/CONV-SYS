"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { fail, type Result } from "@/lib/action-result";
import { requireRole } from "@/lib/auth/session";
import { addVa, fireVa, regenerateInvite, type Invite } from "@/lib/team";

const id = z.string().min(1).max(64);

export async function addVaAction(handle: unknown): Promise<Result<Invite>> {
  const actor = await requireRole("LEAD_VA");
  const parsed = z.string().max(64).safeParse(handle);
  if (!parsed.success) return fail("Enter your VA's Telegram username.");
  const result = await addVa(actor, parsed.data);
  revalidatePath("/lead-va");
  return result;
}

export async function regenerateInviteAction(vaId: unknown): Promise<Result<Invite>> {
  const actor = await requireRole("LEAD_VA");
  const parsed = id.safeParse(vaId);
  if (!parsed.success) return fail("Invalid request.");
  const result = await regenerateInvite(actor, parsed.data);
  revalidatePath("/lead-va");
  return result;
}

export async function fireVaAction(vaId: unknown): Promise<Result<null>> {
  const actor = await requireRole("LEAD_VA");
  const parsed = id.safeParse(vaId);
  if (!parsed.success) return fail("Invalid request.");
  const result = await fireVa(actor, parsed.data);
  revalidatePath("/lead-va");
  return result;
}
