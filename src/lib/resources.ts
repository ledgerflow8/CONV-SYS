// Resources (PLAN.md §7): SOP links, TG media, creator templates and the media pool, per model.
// Director writes; everyone reads through scopeFor(user).resource.
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { db } from "@/lib/db";
import { audit } from "@/lib/audit";
import { fail, type Result } from "@/lib/action-result";
import type { CurrentUser } from "@/lib/auth/session";
import { scopeFor, type ScopeUser } from "@/lib/scope";
import { SECTION_KEYS, SECTIONS, type Section } from "@/lib/resource-sections";
import { ALLOWED_TYPES, MAX_UPLOAD_BYTES, safeFileName, storage } from "@/lib/storage";

export { SECTION_KEYS, SECTIONS, type Section };

// Paths are generated here and nowhere else: "<modelId|shared>/<uuid>/<safe name>".
const PATH = /^(shared|[a-z0-9]{20,40})\/[0-9a-f-]{36}\/[A-Za-z0-9._-]{1,100}$/;

export async function prepareUpload(
  actor: CurrentUser,
  input: { filename: string; size: number; contentType: string; modelId: string | null },
): Promise<Result<{ path: string; signedUrl: string }>> {
  if (actor.role !== "DIRECTOR") return fail("Only the Director can upload resources.");
  if (!(ALLOWED_TYPES as readonly string[]).includes(input.contentType)) {
    return fail("That file type isn't allowed. Use images (JPG, PNG, WebP, GIF), MP4/MOV video, PDF or ZIP.");
  }
  if (input.size <= 0 || input.size > MAX_UPLOAD_BYTES) return fail(`Files must be under ${MAX_UPLOAD_BYTES / 1024 / 1024} MB.`);
  if (input.modelId && !(await db.model.findUnique({ where: { id: input.modelId } }))) return fail("Model not found.");

  const path = `${input.modelId ?? "shared"}/${randomUUID()}/${safeFileName(input.filename)}`;
  const { signedUrl } = await storage().createUploadUrl(path);
  return { ok: true, data: { path, signedUrl } };
}

export const resourceInput = z.object({
  section: z.enum(SECTION_KEYS as [Section, ...Section[]]),
  modelId: z.string().min(1).max(64).nullable(),
  category: z.string().trim().max(40).optional(),
  title: z.string().trim().min(1, "Give it a title").max(120),
  url: z.string().trim().max(1000).optional(),
  filePath: z.string().max(200).optional(),
  sort: z.number().int().min(0).max(9999).optional(),
});

export async function createResource(actor: CurrentUser, raw: unknown): Promise<Result<{ id: string }>> {
  if (actor.role !== "DIRECTOR") return fail("Only the Director can add resources.");
  const parsed = resourceInput.safeParse(raw);
  if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? "Invalid resource.");
  const r = parsed.data;
  const accepts = SECTIONS[r.section].accepts;

  let url: string | null = null;
  if (r.url) {
    try {
      const u = new URL(r.url);
      if (u.protocol !== "https:") throw new Error();
      url = u.toString();
    } catch {
      return fail("Links must be full https:// URLs.");
    }
  }
  const filePath = r.filePath ?? null;
  if (filePath) {
    if (!PATH.test(filePath) || !filePath.startsWith(`${r.modelId ?? "shared"}/`)) return fail("Invalid upload. Try again.");
    if (!(await storage().exists(filePath))) return fail("The upload didn't finish. Try again.");
  }
  if (accepts === "link" && (!url || filePath)) return fail(`${SECTIONS[r.section].label} need a link.`);
  if (accepts === "file" && (!filePath || url)) return fail(`${SECTIONS[r.section].label} need a file.`);
  if (accepts === "either" && !url === !filePath) return fail("Add either a link or a file.");
  if (r.section === "MEDIA_POOL" && !r.category) return fail("Pick a category for the media pool.");
  if (r.modelId && !(await db.model.findUnique({ where: { id: r.modelId } }))) return fail("Model not found.");

  const id = await db.$transaction(async (tx) => {
    const res = await tx.resource.create({
      data: {
        section: r.section,
        modelId: r.modelId,
        category: r.section === "MEDIA_POOL" ? r.category! : r.category || null,
        title: r.title,
        url,
        filePath,
        sort: r.sort ?? 0,
      },
    });
    await audit(tx, { actorId: actor.id, action: "resource.create", target: res.id, meta: { section: r.section, title: r.title, file: !!filePath } });
    return res.id;
  });
  return { ok: true, data: { id } };
}

export async function deleteResource(actor: CurrentUser, id: string): Promise<Result<null>> {
  if (actor.role !== "DIRECTOR") return fail("Only the Director can delete resources.");
  const res = await db.resource.findUnique({ where: { id } });
  if (!res) return fail("Resource not found.");
  await db.$transaction(async (tx) => {
    await tx.resource.delete({ where: { id } });
    await audit(tx, { actorId: actor.id, action: "resource.delete", target: id, meta: { title: res.title, filePath: res.filePath } });
  });
  // After the row is gone: if storage removal fails, the file is orphaned (harmless), never a dangling row.
  if (res.filePath) await storage().remove([res.filePath]).catch(() => undefined);
  return { ok: true, data: null };
}

/** Scoped lookup → short-lived signed URL. Null if the user may not see it (or it has no file). */
export async function resourceFileUrl(user: ScopeUser, id: string, opts: { inline: boolean }): Promise<string | null> {
  const res = await db.resource.findFirst({ where: { AND: [scopeFor(user).resource, { id }] } });
  if (!res?.filePath) return null;
  const ext = res.filePath.split(".").pop();
  const filename = opts.inline ? undefined : `${safeFileName(res.title)}${ext && !res.title.endsWith(`.${ext}`) ? `.${ext}` : ""}`;
  return storage().downloadUrl(res.filePath, { filename, expiresIn: 60 });
}

export function isImage(path: string | null): boolean {
  return !!path && /\.(jpe?g|png|webp|gif)$/i.test(path);
}
