"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { fail, type Result } from "@/lib/action-result";
import { requireRole } from "@/lib/auth/session";
import { createModel, setModelActive } from "@/lib/models";
import { createManagedUser, regeneratePassword, setLeadManagerStatus, type Credentials } from "@/lib/people";
import { addPoolAccount, importPoolAccounts, type ImportSummary } from "@/lib/pool";
import { importConvosCsv, type ConvoImportSummary } from "@/lib/convo-import";
import { retryConvo, reviewConvo, type IngestOutcome } from "@/lib/ingest";
import { saveSettings } from "@/lib/settings";
import { parseSettingsForm, type SettingsFormErrors } from "@/lib/settings-form";

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

// ── Settings ──────────────────────────────────────────────────────────────

const settingsInput = z.object({
  rateVa: z.string().max(20),
  rateLeadVa: z.string().max(20),
  rateLm: z.string().max(20),
  tier1Countries: z.string().max(2000),
  blockedDomains: z.string().max(50_000),
  timezone: z.string().max(40),
  payoutCurrency: z.string().max(60),
  clickMatchWindowMin: z.string().max(10),
  supportTelegram: z.string().max(64),
});

export async function saveSettingsAction(
  input: unknown,
): Promise<{ ok: true; changed: string[] } | { ok: false; error?: string; errors?: SettingsFormErrors }> {
  const actor = await requireRole("DIRECTOR");
  const shape = settingsInput.safeParse(input);
  if (!shape.success) return { ok: false, error: "Invalid request." };
  const parsed = parseSettingsForm(shape.data);
  if (!parsed.ok) return { ok: false, errors: parsed.errors };

  const result = await saveSettings(actor, parsed.settings);
  if (!result.ok) return { ok: false, error: result.error };
  revalidatePath("/", "layout"); // timezone pill + support link appear on every page
  return { ok: true, changed: result.data.changed };
}

// ── Convos ────────────────────────────────────────────────────────────────

export async function importConvosAction(text: unknown): Promise<Result<ConvoImportSummary>> {
  const actor = await requireRole("DIRECTOR");
  const parsed = z.string().max(5_000_000).safeParse(text);
  if (!parsed.success) return fail("Choose a CSV file (max 5 MB).");
  const result = await importConvosCsv(actor, parsed.data);
  revalidatePath("/director/convos");
  return result;
}

export async function reviewConvoAction(convoId: unknown, decision: unknown): Promise<Result<IngestOutcome>> {
  const actor = await requireRole("DIRECTOR");
  const parsed = z.tuple([id, z.enum(["approve", "reject"])]).safeParse([convoId, decision]);
  if (!parsed.success) return fail("Invalid request.");
  const result = await reviewConvo(actor, ...parsed.data);
  revalidatePath("/director/convos");
  return result;
}

export async function retryConvoAction(convoId: unknown): Promise<Result<IngestOutcome>> {
  const actor = await requireRole("DIRECTOR");
  const parsed = id.safeParse(convoId);
  if (!parsed.success) return fail("Invalid request.");
  const result = await retryConvo(actor, parsed.data);
  revalidatePath("/director/convos");
  return result;
}
