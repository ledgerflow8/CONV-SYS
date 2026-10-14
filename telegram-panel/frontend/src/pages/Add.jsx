import { useEffect, useRef, useState } from "react";
import { CheckCircle2, XCircle, AlertTriangle, Upload, Loader2 } from "lucide-react";
import { api } from "../api.js";

const ICON = {
  connected: <CheckCircle2 className="size-5 text-emerald-500" />,
  dead: <XCircle className="size-5 text-red-500" />,
  invalid: <XCircle className="size-5 text-red-500" />,
  duplicate: <AlertTriangle className="size-5 text-amber-500" />,
  pending: <Loader2 className="size-5 animate-spin text-muted-foreground" />,
};

export default function Add() {
  const [tab, setTab] = useState("upload");
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold">Add accounts</h1>
      <div className="flex gap-2">
        {[
          ["upload", "Upload sessions"],
          ["phone", "Phone login"],
        ].map(([k, label]) => (
          <button
            key={k}
            type="button"
            onClick={() => setTab(k)}
            className={`rounded-lg px-3 py-1.5 text-sm font-medium ${tab === k ? "bg-secondary" : "hover:bg-secondary/60"}`}
          >
            {label}
          </button>
        ))}
      </div>
      {tab === "upload" ? <UploadTab /> : <PhoneTab />}
    </div>
  );
}

function UploadTab() {
  const [job, setJob] = useState(null);
  const [status, setStatus] = useState(null);
  const [error, setError] = useState("");
  const [uploading, setUploading] = useState(false);
  const input = useRef(null);
  const poll = useRef(null);

  const send = async (files) => {
    if (!files.length) return;
    setError("");
    setUploading(true);
    setStatus(null);
    const fd = new FormData();
    for (const f of files) fd.append("files", f);
    try {
      const res = await api("/api/imports", { method: "POST", body: fd });
      setJob(res.job_id);
    } catch (e) {
      setError(e.message);
    } finally {
      setUploading(false);
    }
  };

  useEffect(() => {
    if (!job) return;
    const tick = async () => {
      try {
        const s = await api(`/api/imports/${job}`);
        setStatus(s);
        if (s.done) clearInterval(poll.current);
      } catch {
        /* keep polling */
      }
    };
    tick();
    poll.current = setInterval(tick, 1000);
    return () => clearInterval(poll.current);
  }, [job]);

  const counts = (status?.results ?? []).reduce((a, r) => ((a[r.result] = (a[r.result] || 0) + 1), a), {});

  return (
    <div className="space-y-4">
      <div
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          send([...e.dataTransfer.files]);
        }}
        className="rounded-xl border border-dashed bg-card p-8 text-center"
      >
        <Upload className="mx-auto size-7 text-muted-foreground" />
        <p className="mt-2 font-medium">Drop .session files or a .zip</p>
        <p className="text-sm text-muted-foreground">Pair each with a same-named .json when you have one.</p>
        <button
          type="button"
          onClick={() => input.current.click()}
          disabled={uploading}
          className="mt-4 inline-flex h-10 items-center gap-2 rounded-lg bg-primary px-4 text-sm font-medium text-primary-foreground disabled:opacity-50"
        >
          {uploading ? "Uploading…" : "Choose files"}
        </button>
        <input
          ref={input}
          type="file"
          multiple
          accept=".session,.json,.zip"
          className="hidden"
          onChange={(e) => send([...e.target.files])}
        />
      </div>

      {error && <p className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>}

      {status && (
        <div className="space-y-2">
          <div className="flex items-center justify-between text-sm text-muted-foreground">
            <span>
              {status.processed}/{status.total} tested
              {counts.connected ? ` · ${counts.connected} added` : ""}
            </span>
            {!status.done && <Loader2 className="size-4 animate-spin" />}
          </div>
          <ul className="divide-y rounded-xl border bg-card">
            {status.results.map((r, i) => (
              <li key={i} className="flex items-center gap-3 p-3">
                {ICON[r.result] ?? ICON.pending}
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium">
                    {r.username ? `@${r.username}` : r.filename}
                    {r.phone ? <span className="text-muted-foreground"> · {r.phone}</span> : null}
                  </div>
                  <div className="truncate text-xs text-muted-foreground">
                    {r.result === "connected" ? "Connected" : r.detail || r.result}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function PhoneTab() {
  return (
    <div className="rounded-xl border bg-card p-6 text-sm text-muted-foreground">
      Phone login arrives in step 4. For now, add accounts by uploading their session files.
    </div>
  );
}
