// Supabase Storage for resource files. SERVER ONLY: uses the service-role key, which bypasses
// all access rules. The browser only ever sees one-time signed upload URLs and short-lived
// signed download URLs, issued after our own scope checks.
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

export const RESOURCE_BUCKET = "resources";
export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
export const ALLOWED_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "video/mp4",
  "video/quicktime",
  "application/pdf",
  "application/zip",
] as const;

export interface FileStorage {
  ensureBucket(): Promise<void>;
  createUploadUrl(path: string): Promise<{ signedUrl: string }>;
  exists(path: string): Promise<boolean>;
  downloadUrl(path: string, opts: { filename?: string; expiresIn: number }): Promise<string>;
  remove(paths: string[]): Promise<void>;
  /** Every object path in the bucket (walks the folder tree). */
  listAll(): Promise<string[]>;
}

let client: SupabaseClient | null = null;
function supabase(): SupabaseClient {
  const raw = process.env.SUPABASE_URL?.trim();
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!raw || !key) throw new Error("Storage isn't configured (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY).");
  // Only scheme + host: a pasted "…supabase.co/rest/v1/" would otherwise break every storage URL.
  const url = new URL(raw).origin;
  client ??= createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  return client;
}

const supabaseStorage: FileStorage = {
  async ensureBucket() {
    const s = supabase().storage;
    const { data } = await s.getBucket(RESOURCE_BUCKET);
    const options = { public: false, fileSizeLimit: MAX_UPLOAD_BYTES, allowedMimeTypes: [...ALLOWED_TYPES] };
    const { error } = data ? await s.updateBucket(RESOURCE_BUCKET, options) : await s.createBucket(RESOURCE_BUCKET, options);
    if (error) throw new Error(`Storage bucket setup failed: ${error.message}`);
  },

  async createUploadUrl(path) {
    const { data, error } = await supabase().storage.from(RESOURCE_BUCKET).createSignedUploadUrl(path);
    if (error || !data) throw new Error(`Couldn't create upload URL: ${error?.message}`);
    return { signedUrl: data.signedUrl };
  },

  async exists(path) {
    const { data, error } = await supabase().storage.from(RESOURCE_BUCKET).exists(path);
    if (error) return false;
    return data;
  },

  async downloadUrl(path, { filename, expiresIn }) {
    const { data, error } = await supabase()
      .storage.from(RESOURCE_BUCKET)
      .createSignedUrl(path, expiresIn, filename ? { download: filename } : undefined);
    if (error || !data) throw new Error(`Couldn't sign download: ${error?.message}`);
    return data.signedUrl;
  },

  async remove(paths) {
    if (paths.length === 0) return;
    // The API removes up to 1000 objects per call.
    for (let i = 0; i < paths.length; i += 1000) {
      const { error } = await supabase().storage.from(RESOURCE_BUCKET).remove(paths.slice(i, i + 1000));
      if (error) throw new Error(`Couldn't delete file: ${error.message}`);
    }
  },

  async listAll() {
    const bucket = supabase().storage.from(RESOURCE_BUCKET);
    const out: string[] = [];
    const walk = async (prefix: string) => {
      for (let offset = 0; ; offset += 1000) {
        const { data, error } = await bucket.list(prefix || undefined, { limit: 1000, offset });
        if (error) throw new Error(`Couldn't list files: ${error.message}`);
        for (const entry of data ?? []) {
          const path = prefix ? `${prefix}/${entry.name}` : entry.name;
          // Folders have no id; files do.
          if (entry.id === null) await walk(path);
          else out.push(path);
        }
        if (!data || data.length < 1000) break;
      }
    };
    await walk("");
    return out;
  },
};

let impl: FileStorage = supabaseStorage;
export const storage = (): FileStorage => impl;
/** Tests only: swap in a fake. */
export function setStorageForTests(s: FileStorage | null) {
  impl = s ?? supabaseStorage;
}

/** "My Template (final).PSD" → "My-Template-final.psd". Keeps the extension, drops anything path-like. */
export function safeFileName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "file";
  const dot = base.lastIndexOf(".");
  const stem = (dot > 0 ? base.slice(0, dot) : base).normalize("NFKD").replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[-.]+|[-.]+$/g, "").slice(0, 80);
  const ext = dot > 0 ? base.slice(dot + 1).toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 10) : "";
  return `${stem || "file"}${ext ? `.${ext}` : ""}`;
}
