import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { createResource, deleteResource, prepareUpload, resourceFileUrl } from "@/lib/resources";
import { setStorageForTests, type FileStorage } from "@/lib/storage";
import { asActor, makeTeam, makeModel, makeUser, resetDb } from "../../test/fixtures";

// In-memory stand-in for Supabase Storage.
const files = new Set<string>();
const removed: string[] = [];
const fake: FileStorage = {
  ensureBucket: async () => {},
  createUploadUrl: async (path) => ({ signedUrl: `https://fake/upload/${path}?token=t` }),
  exists: async (path) => files.has(path),
  downloadUrl: async (path, { filename }) => `https://fake/get/${path}${filename ? `?download=${filename}` : ""}`,
  remove: async (paths) => {
    for (const p of paths) {
      files.delete(p);
      removed.push(p);
    }
  },
};
setStorageForTests(fake);
afterAll(() => setStorageForTests(null));

beforeEach(async () => {
  await resetDb();
  files.clear();
  removed.length = 0;
});

async function upload(actor: ReturnType<typeof asActor>, modelId: string | null, filename = "pfp.png") {
  const r = await prepareUpload(actor, { filename, size: 1000, contentType: "image/png", modelId });
  if (!r.ok) throw new Error(r.error);
  files.add(r.data.path); // the browser PUTs to the signed URL
  return r.data.path;
}

describe("resources", () => {
  it("prepareUpload: Director only, allowed types and sizes, server-generated path", async () => {
    const t = await makeTeam();
    const D = asActor(t.director);
    expect((await prepareUpload(asActor(t.lva), { filename: "a.png", size: 10, contentType: "image/png", modelId: null })).ok).toBe(false);
    expect((await prepareUpload(D, { filename: "a.exe", size: 10, contentType: "application/x-msdownload", modelId: null })).ok).toBe(false);
    expect((await prepareUpload(D, { filename: "a.png", size: 60 * 1024 * 1024, contentType: "image/png", modelId: null })).ok).toBe(false);
    const ok = await prepareUpload(D, { filename: "../../My PFP.PNG", size: 10, contentType: "image/png", modelId: t.model.id });
    expect(ok.ok && ok.data.path).toMatch(new RegExp(`^${t.model.id}/[0-9a-f-]{36}/My-PFP\\.png$`));
  });

  it("createResource enforces link/file per section and a finished upload", async () => {
    const t = await makeTeam();
    const D = asActor(t.director);
    const path = await upload(D, t.model.id);

    expect((await createResource(D, { section: "SOP", modelId: null, title: "Guide", url: "http://insecure.com" })).ok).toBe(false);
    expect((await createResource(D, { section: "SOP", modelId: null, title: "Guide", url: "https://docs.example.com/sop" })).ok).toBe(true);
    expect((await createResource(D, { section: "TG_MEDIA", modelId: t.model.id, title: "Banner", url: "https://x.com" })).ok).toBe(false);
    expect((await createResource(D, { section: "MEDIA_POOL", modelId: t.model.id, title: "PFP 1", filePath: path })).ok).toBe(false); // no category
    expect((await createResource(D, { section: "MEDIA_POOL", modelId: t.model.id, category: "PFPs", title: "PFP 1", filePath: path })).ok).toBe(true);
    // a path that was never uploaded, or one forged for another model
    expect((await createResource(D, { section: "TG_MEDIA", modelId: t.model.id, title: "X", filePath: `${t.model.id}/00000000-0000-0000-0000-000000000000/x.png` })).ok).toBe(false);
    const other = await makeModel();
    expect((await createResource(D, { section: "TG_MEDIA", modelId: other.id, title: "X", filePath: path })).ok).toBe(false);
    expect((await createResource(D, { section: "CREATOR_TEMPLATE", modelId: null, title: "Both", url: "https://a.com", filePath: path })).ok).toBe(false);
    expect((await createResource(asActor(t.lva), { section: "SOP", modelId: null, title: "x", url: "https://a.com" })).ok).toBe(false);
  });

  it("downloads are scoped: shared + own model only", async () => {
    const t = await makeTeam();
    const D = asActor(t.director);
    const otherModel = await makeModel();
    const mine = await createResource(D, { section: "TG_MEDIA", modelId: t.model.id, title: "Mine", filePath: await upload(D, t.model.id) });
    const shared = await createResource(D, { section: "TG_MEDIA", modelId: null, title: "Shared", filePath: await upload(D, null) });
    const theirs = await createResource(D, { section: "TG_MEDIA", modelId: otherModel.id, title: "Theirs", filePath: await upload(D, otherModel.id) });
    if (!mine.ok || !shared.ok || !theirs.ok) throw new Error("setup");

    const va = asActor(t.va);
    expect(await resourceFileUrl(va, mine.data.id, { inline: false })).toMatch(/download=Mine\.png$/);
    expect(await resourceFileUrl(va, shared.data.id, { inline: true })).not.toContain("download=");
    expect(await resourceFileUrl(va, theirs.data.id, { inline: false })).toBeNull();

    const noModelVa = await makeUser("VA", t.lva.id, null);
    expect(await resourceFileUrl(asActor(noModelVa), mine.data.id, { inline: false })).toBeNull();
    expect(await resourceFileUrl(asActor(noModelVa), shared.data.id, { inline: false })).not.toBeNull();
  });

  it("delete removes the row, then the file", async () => {
    const t = await makeTeam();
    const D = asActor(t.director);
    const path = await upload(D, t.model.id);
    const r = await createResource(D, { section: "TG_MEDIA", modelId: t.model.id, title: "Gone", filePath: path });
    if (!r.ok) throw new Error("setup");
    expect((await deleteResource(asActor(t.lva), r.data.id)).ok).toBe(false);
    expect((await deleteResource(D, r.data.id)).ok).toBe(true);
    expect(await db.resource.count()).toBe(0);
    expect(removed).toEqual([path]);
    expect(await db.auditLog.count({ where: { action: "resource.delete" } })).toBe(1);
  });
});
