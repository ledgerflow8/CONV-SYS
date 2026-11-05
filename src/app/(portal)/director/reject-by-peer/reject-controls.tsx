"use client";

import { useState, useTransition } from "react";
import { Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { PeerPreview, PeerRowStatus } from "@/lib/reject-by-peer";
import { applyPeerRejectAction, previewPeerRejectAction } from "../actions";

const LABEL: Record<PeerRowStatus, string> = {
  found: "Will reject",
  already_rejected: "Already rejected",
  locked_week: "In a locked week (skipped)",
  not_found: "Not found",
  invalid: "Couldn't read the line",
};
const ORDER: PeerRowStatus[] = ["found", "already_rejected", "locked_week", "not_found", "invalid"];

export function RejectByPeerControls() {
  const [text, setText] = useState("");
  const [preview, setPreview] = useState<PeerPreview | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [pending, startTransition] = useTransition();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const reset = () => { setPreview(null); setConfirm(false); setMsg(null); };

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    setText(await file.text());
    reset();
  };

  const doPreview = () =>
    startTransition(async () => {
      setMsg(null);
      const r = await previewPeerRejectAction(text);
      if (!r.ok) return setMsg({ ok: false, text: r.error });
      setPreview(r.data);
      setConfirm(false);
    });

  const doApply = () =>
    startTransition(async () => {
      const r = await applyPeerRejectAction(text);
      setConfirm(false);
      if (!r.ok) return setMsg({ ok: false, text: r.error });
      setPreview(null);
      setMsg({ ok: true, text: `Rejected ${r.data.rejected}${r.data.skipped.length ? `, skipped ${r.data.skipped.length} (changed since preview)` : ""}.` });
    });

  const found = preview?.counts.found ?? 0;

  return (
    <div className="space-y-3 text-sm">
      <p className="text-muted-foreground">
        Paste one <code>tgAccount, peerId</code> per line (comma, tab or space separated). A header row is ignored. Only convos in unlocked weeks are
        changed.
      </p>
      <textarea
        value={text}
        onChange={(e) => { setText(e.target.value); reset(); }}
        rows={8}
        placeholder={"sophiejetlag, 8533747838\nlilyrose, 7421009981"}
        className="w-full rounded-lg border bg-background p-3 font-mono text-xs"
      />
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="outline" disabled={pending || !text.trim()} onClick={doPreview}>
          Preview
        </Button>
        <label className="inline-flex cursor-pointer items-center gap-1 rounded-md border px-3 py-1.5 text-sm hover:bg-muted">
          <Upload className="size-4" /> Upload file
          <input type="file" accept=".csv,.txt,text/plain,text/csv" className="hidden" onChange={(e) => onFile(e.target.files?.[0])} />
        </label>
      </div>

      {preview && (
        <div className="space-y-3 rounded-xl border bg-card p-3">
          <div className="flex flex-wrap gap-2">
            {ORDER.filter((s) => (preview.counts[s] ?? 0) > 0).map((s) => (
              <span key={s} className="rounded-full border px-3 py-1">
                {LABEL[s]}: <strong>{preview.counts[s]}</strong>
              </span>
            ))}
          </div>
          <div className="max-h-72 overflow-y-auto rounded-lg border">
            <table className="w-full text-left text-xs">
              <thead className="sticky top-0 bg-muted">
                <tr><th className="px-2 py-1">tgAccount</th><th className="px-2 py-1">peerId</th><th className="px-2 py-1">Outcome</th></tr>
              </thead>
              <tbody>
                {preview.rows.slice(0, 500).map((r, i) => (
                  <tr key={i} className="border-t">
                    <td className="px-2 py-1">@{r.tgAccount}</td>
                    <td className="px-2 py-1 font-mono">{r.peerId}</td>
                    <td className={`px-2 py-1 ${r.status === "found" ? "text-destructive" : "text-muted-foreground"}`}>{LABEL[r.status]}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {preview.rows.length > 500 && <p className="p-2 text-muted-foreground">Showing the first 500 of {preview.rows.length}.</p>}
          </div>
          {found > 0 ? (
            confirm ? (
              <div className="flex items-center gap-2">
                <Button size="sm" variant="destructive" disabled={pending} onClick={doApply}>
                  {pending ? "Rejecting…" : `Confirm: reject ${found}`}
                </Button>
                <Button size="sm" variant="ghost" disabled={pending} onClick={() => setConfirm(false)}>Cancel</Button>
              </div>
            ) : (
              <Button size="sm" variant="destructive" disabled={pending} onClick={() => setConfirm(true)}>
                Reject {found} convo{found === 1 ? "" : "s"}
              </Button>
            )
          ) : (
            <p className="text-muted-foreground">Nothing to reject.</p>
          )}
        </div>
      )}
      {msg && <p className={msg.ok ? "text-emerald-700 dark:text-emerald-400" : "text-destructive"}>{msg.text}</p>}
    </div>
  );
}
