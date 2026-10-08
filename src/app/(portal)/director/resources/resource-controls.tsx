"use client";

import { useState, useTransition } from "react";
import { Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SECTIONS, type Section } from "@/lib/resource-sections";
import { createResourceAction, deleteResourceAction, prepareUploadAction } from "../actions";

const ACCEPT = "image/jpeg,image/png,image/webp,image/gif,video/mp4,video/quicktime,application/pdf,application/zip";

/** PUT straight to Supabase via the signed URL, with progress. */
function putFile(url: string, file: File, onProgress: (pct: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url);
    xhr.setRequestHeader("Content-Type", file.type);
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(Math.round((e.loaded / e.total) * 100));
    xhr.onload = () => (xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new Error(`Upload failed (${xhr.status})`)));
    xhr.onerror = () => reject(new Error("Upload failed (network)"));
    xhr.send(file);
  });
}

export function AddResourceForm({ models, categories }: { models: { id: string; name: string }[]; categories: string[] }) {
  const [section, setSection] = useState<Section>("SOP");
  const [modelId, setModelId] = useState<string>("");
  const [category, setCategory] = useState("");
  const [title, setTitle] = useState("");
  const [url, setUrl] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [mode, setMode] = useState<"link" | "file">("link");
  const [progress, setProgress] = useState<number | null>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, startTransition] = useTransition();
  const [fileKey, setFileKey] = useState(0);

  const accepts = SECTIONS[section].accepts;
  const useFile = accepts === "file" || (accepts === "either" && mode === "file");

  function reset() {
    setTitle("");
    setUrl("");
    setFile(null);
    setFileKey((k) => k + 1);
    setProgress(null);
  }

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setMessage(null);
    startTransition(async () => {
      try {
        let filePath: string | undefined;
        if (useFile) {
          if (!file) return setMessage({ ok: false, text: "Choose a file." });
          const prep = await prepareUploadAction({ filename: file.name, size: file.size, contentType: file.type, modelId: modelId || null });
          if (!prep.ok) return setMessage({ ok: false, text: prep.error });
          setProgress(0);
          await putFile(prep.data.signedUrl, file, setProgress);
          filePath = prep.data.path;
        }
        const r = await createResourceAction({
          section,
          modelId: modelId || null,
          category: category.trim() || undefined,
          title: title.trim() || file?.name || "",
          url: useFile ? undefined : url.trim(),
          filePath,
        });
        if (!r.ok) return setMessage({ ok: false, text: r.error });
        setMessage({ ok: true, text: "Added." });
        reset();
      } catch (err) {
        setProgress(null);
        setMessage({ ok: false, text: err instanceof Error ? err.message : "Upload failed." });
      }
    });
  }

  const select = "h-9 w-full rounded-md border bg-background px-3 text-sm";
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Add a resource</CardTitle>
      </CardHeader>
      <CardContent>
        <form onSubmit={submit} className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="r-section">Section</Label>
              <select id="r-section" className={select} value={section} onChange={(e) => setSection(e.target.value as Section)}>
                {(Object.keys(SECTIONS) as Section[]).map((s) => (
                  <option key={s} value={s}>
                    {SECTIONS[s].label}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="r-model">Model</Label>
              <select
                id="r-model"
                className={select}
                value={modelId}
                onChange={(e) => setModelId(e.target.value)}
                aria-describedby="r-model-visibility"
              >
                <option value="">All models</option>
                {models.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </select>
              <p id="r-model-visibility" className="text-xs text-muted-foreground">
                Visible to:{" "}
                <strong className="text-foreground">
                  {modelId ? `${models.find((m) => m.id === modelId)?.name ?? "this model"} teams only` : "everyone"}
                </strong>
              </p>
            </div>
          </div>

          {section === "MEDIA_POOL" && (
            <div className="space-y-1.5">
              <Label htmlFor="r-category">Category</Label>
              <Input id="r-category" list="r-categories" value={category} onChange={(e) => setCategory(e.target.value)} placeholder="PFPs, Post Pictures…" maxLength={40} />
              <datalist id="r-categories">
                {categories.map((c) => (
                  <option key={c} value={c} />
                ))}
              </datalist>
            </div>
          )}

          <div className="space-y-1.5">
            <Label htmlFor="r-title">Title</Label>
            <Input id="r-title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder={useFile ? "Defaults to the file name" : "e.g. Daily posting SOP"} maxLength={120} />
          </div>

          {accepts === "either" && (
            <div className="flex gap-2 text-sm">
              {(["link", "file"] as const).map((m) => (
                <label key={m} className="flex items-center gap-1">
                  <input type="radio" name="r-mode" checked={mode === m} onChange={() => setMode(m)} /> {m === "link" ? "Link" : "File"}
                </label>
              ))}
            </div>
          )}

          {useFile ? (
            <div className="space-y-1.5">
              <Label htmlFor="r-file">File (max 50 MB)</Label>
              <Input key={fileKey} id="r-file" type="file" accept={ACCEPT} onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
              {progress !== null && (
                <div className="h-2 w-full overflow-hidden rounded bg-muted" role="progressbar" aria-valuenow={progress}>
                  <div className="h-full bg-primary transition-all" style={{ width: `${progress}%` }} />
                </div>
              )}
            </div>
          ) : (
            <div className="space-y-1.5">
              <Label htmlFor="r-url">Link</Label>
              <Input id="r-url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…" inputMode="url" autoCapitalize="none" />
            </div>
          )}

          <div className="flex items-center gap-3">
            <Button type="submit" disabled={pending}>
              {pending ? (progress !== null ? `Uploading ${progress}%` : "Saving…") : "Add resource"}
            </Button>
            {message && (
              <p role="status" className={message.ok ? "text-sm text-emerald-600" : "text-sm text-destructive"}>
                {message.text}
              </p>
            )}
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

export function DeleteResourceButton({ id, title }: { id: string; title: string }) {
  const [confirm, setConfirm] = useState(false);
  const [pending, startTransition] = useTransition();
  if (!confirm) {
    return (
      <Button size="icon" variant="ghost" aria-label={`Delete ${title}`} onClick={() => setConfirm(true)}>
        <Trash2 className="size-4" />
      </Button>
    );
  }
  return (
    <span className="flex items-center gap-1">
      <Button size="sm" variant="destructive" disabled={pending} onClick={() => startTransition(async () => void (await deleteResourceAction(id)))}>
        {pending ? "…" : "Delete"}
      </Button>
      <Button size="sm" variant="ghost" onClick={() => setConfirm(false)} disabled={pending}>
        Cancel
      </Button>
    </span>
  );
}
