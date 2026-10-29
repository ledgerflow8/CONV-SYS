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
import { approvePendingConvosAction, importConvosAction, retryConvoAction, reviewConvoAction, syncCapitalAINowAction } from "../actions";

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

/**
 * Pending list with checkboxes and "Approve selected" (Director override after an outage). Two steps: the
 * count and what it means, then Confirm. Nothing is approved without that click.
 */
export function PendingApproveList({ rows, currentWeek }: { rows: { id: string; content: React.ReactNode }[]; currentWeek: string }) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirm, setConfirm] = useState(false);
  const [pending, startTransition] = useTransition();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const all = rows.length > 0 && rows.every((r) => selected.has(r.id));
  const toggle = (id: string) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  const approve = () =>
    startTransition(async () => {
      const r = await approvePendingConvosAction([...selected]);
      setConfirm(false);
      if (!r.ok) return setMsg({ ok: false, text: r.error });
      const { approved, late, skipped } = r.data;
      const reasons = Object.entries(skipped.reduce<Record<string, number>>((m, s) => ({ ...m, [s.reason]: (m[s.reason] ?? 0) + 1 }), {}))
        .map(([reason, n]) => `${n} ${reason.toLowerCase()}`)
        .join(", ");
      setMsg({
        ok: true,
        text:
          `Approved ${approved}${late ? ` (${late} paid in ${currentWeek}, since their own week is locked)` : ""}.` +
          (skipped.length ? ` Skipped ${skipped.length}: ${reasons}.` : ""),
      });
      setSelected(new Set());
    });

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <Button size="sm" variant="outline" disabled={rows.length === 0 || pending} onClick={() => setSelected(all ? new Set() : new Set(rows.map((r) => r.id)))}>
          {all ? "Clear selection" : `Select all shown (${rows.length})`}
        </Button>
        <span className="text-muted-foreground">{selected.size} selected</span>
        <Button size="sm" disabled={selected.size === 0 || pending} onClick={() => setConfirm(true)}>
          Approve selected
        </Button>
      </div>
      {confirm && (
        <div className="space-y-2 rounded-lg border border-primary/40 bg-primary/5 p-3 text-sm">
          <p>
            Count <strong>{selected.size}</strong> pending {selected.size === 1 ? "convo" : "convos"} as qualified, without a reply? Each pays its
            VA, Lead VA and Lead Manager at today&apos;s rates and counts on this week&apos;s leaderboards. Convos from a locked week are paid in{" "}
            <strong>{currentWeek}</strong>. This can&apos;t be undone.
          </p>
          <p className="text-muted-foreground">Skipped automatically: any that are no longer pending, had no VA on the account, or aren&apos;t Tier 1.</p>
          <div className="flex gap-2">
            <Button size="sm" disabled={pending} onClick={approve}>
              {pending ? "Approving…" : `Confirm: approve ${selected.size}`}
            </Button>
            <Button size="sm" variant="ghost" disabled={pending} onClick={() => setConfirm(false)}>
              Cancel
            </Button>
          </div>
        </div>
      )}
      {msg && <p className={msg.ok ? "text-sm text-emerald-700 dark:text-emerald-400" : "text-sm text-destructive"}>{msg.text}</p>}
      <ul className="divide-y rounded-xl border bg-card">
        {rows.length === 0 && <li className="p-4 text-sm text-muted-foreground">No pending convos match.</li>}
        {rows.map((r) => (
          <li key={r.id} className="flex items-start gap-3 px-4 py-3">
            <input
              type="checkbox"
              className="mt-1 size-4 shrink-0"
              aria-label="Select convo"
              checked={selected.has(r.id)}
              onChange={() => toggle(r.id)}
              disabled={pending}
            />
            <div className="min-w-0 flex-1">{r.content}</div>
          </li>
        ))}
      </ul>
    </div>
  );
}
