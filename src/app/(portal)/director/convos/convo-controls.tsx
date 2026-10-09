"use client";

import { useState, useTransition } from "react";
import { Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { ConvoImportSummary } from "@/lib/convo-import";
import { importConvosAction, retryConvoAction, reviewConvoAction, syncCapitalAINowAction } from "../actions";

export function ReviewActions({ convoId, canApprove }: { convoId: string; canApprove: boolean }) {
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);

  const run = (fn: () => Promise<{ ok: boolean; error?: string; data?: { status: string } }>) =>
    startTransition(async () => {
      const r = await fn();
      setMessage(r.ok ? null : (r.error ?? "Something went wrong."));
      if (r.ok && r.data?.status === "REVIEW") setMessage("Still needs review. Check the pool and assignments.");
    });

  return (
    <div className="flex flex-wrap items-center gap-2">
      {canApprove ? (
        <Button size="sm" disabled={pending} onClick={() => run(() => reviewConvoAction(convoId, "approve"))}>
          Approve
        </Button>
      ) : (
        <Button size="sm" variant="outline" disabled={pending} onClick={() => run(() => retryConvoAction(convoId))}>
          Retry
        </Button>
      )}
      <Button
        size="sm"
        variant="ghost"
        className="text-destructive hover:text-destructive"
        disabled={pending}
        onClick={() => run(() => reviewConvoAction(convoId, "reject"))}
      >
        Reject
      </Button>
      {message && <span className="text-xs text-destructive">{message}</span>}
    </div>
  );
}

export function ImportConvosDialog() {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState<string | null>(null);
  const [fileName, setFileName] = useState("");
  const [summary, setSummary] = useState<ConvoImportSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function reset(o: boolean) {
    setOpen(o);
    if (!o) {
      setText(null);
      setFileName("");
      setSummary(null);
      setError(null);
    }
  }

  async function load(file: File | undefined) {
    setError(null);
    if (!file) return;
    if (file.size > 5_000_000) return setError("File is too large (max 5 MB).");
    setFileName(file.name);
    setText(await file.text());
  }

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!text) return;
    setError(null);
    startTransition(async () => {
      const r = await importConvosAction(text);
      if (!r.ok) return setError(r.error);
      setSummary(r.data);
    });
  }

  return (
    <Dialog open={open} onOpenChange={reset}>
      <DialogTrigger asChild>
        <Button variant="outline">
          <Upload className="size-4" />
          Import CSV
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[90dvh] overflow-y-auto">
        {summary ? (
          <div className="space-y-4">
            <DialogHeader>
              <DialogTitle>Import finished</DialogTitle>
              <DialogDescription>{summary.rows} rows processed.</DialogDescription>
            </DialogHeader>
            <ul className="grid grid-cols-2 gap-2 text-sm">
              {(["QUALIFIED", "PENDING", "REVIEW", "REJECTED"] as const).map((s) => (
                <li key={s} className="rounded-lg bg-muted/60 px-3 py-2">
                  <div className="text-lg font-bold">{summary.byStatus[s] ?? 0}</div>
                  <div className="text-xs text-muted-foreground capitalize">{s.toLowerCase()}</div>
                </li>
              ))}
            </ul>
            <p className="text-sm text-muted-foreground">
              {summary.unchanged} already decided (unchanged)
              {summary.late > 0 && ` · ${summary.late} late (moved to the current week)`}
            </p>
            {summary.errors.length > 0 && (
              <ul className="max-h-48 space-y-1 overflow-y-auto rounded-lg border p-3 text-sm">
                {summary.errors.map((e) => (
                  <li key={e.line}>
                    <span className="text-muted-foreground">Line {e.line}:</span> <span className="text-destructive">{e.error}</span>
                  </li>
                ))}
              </ul>
            )}
            <DialogFooter>
              <Button onClick={() => reset(false)}>Done</Button>
            </DialogFooter>
          </div>
        ) : (
          <form onSubmit={submit} className="space-y-4">
            <DialogHeader>
              <DialogTitle>Import convos</DialogTitle>
              <DialogDescription>
                CSV with a header row: <code>tg_account, peer_id, peer_phone, first_msg_at, replied_at, source</code>. Times need a
                timezone, e.g. <code>2026-10-07T14:05:00Z</code>. Re-importing the same rows is safe.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-2">
              <Label htmlFor="convo-csv">CSV file</Label>
              <Input id="convo-csv" type="file" accept=".csv,text/csv" onChange={(e) => load(e.target.files?.[0])} />
              {fileName && <p className="text-xs text-muted-foreground">{fileName}</p>}
            </div>
            {error && (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}
            <DialogFooter>
              <Button type="submit" disabled={!text || pending}>
                {pending ? "Importing…" : "Import"}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

export function SyncNowButton() {
  const [pending, startTransition] = useTransition();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button
        size="sm"
        variant="outline"
        disabled={pending}
        onClick={() =>
          startTransition(async () => {
            const r = await syncCapitalAINowAction();
            setMsg({ ok: r.ok, text: r.message });
          })
        }
      >
        {pending ? "Syncing…" : "Sync now"}
      </Button>
      {msg && <span className={msg.ok ? "text-xs text-muted-foreground" : "text-xs text-destructive"}>{msg.text}</span>}
    </div>
  );
}
