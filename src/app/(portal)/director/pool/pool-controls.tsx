"use client";

import { useState, useTransition } from "react";
import { Plus, Upload } from "lucide-react";
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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import type { ImportSummary } from "@/lib/pool";
import { addPoolAccountAction, importPoolAction, restoreAccountAction, takeAccountOutOfServiceAction } from "../actions";

type ModelOption = { id: string; name: string };

function ModelSelect({ models, value, onChange }: { models: ModelOption[]; value: string; onChange: (v: string) => void }) {
  return (
    <div className="space-y-2">
      <Label htmlFor="pool-model">Model</Label>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger id="pool-model" className="w-full">
          <SelectValue placeholder={models.length ? "Pick a model" : "No active models"} />
        </SelectTrigger>
        <SelectContent>
          {models.map((m) => (
            <SelectItem key={m.id} value={m.id}>
              {m.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

export function AddAccountDialog({ models }: { models: ModelOption[] }) {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ modelId: "", username: "", phone: "", link: "" });
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const set = (k: keyof typeof form) => (v: string) => setForm((f) => ({ ...f, [k]: v }));

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    startTransition(async () => {
      const result = await addPoolAccountAction({ ...form, link: form.link || undefined });
      if (!result.ok) return setError(result.error);
      setForm((f) => ({ modelId: f.modelId, username: "", phone: "", link: "" }));
      setOpen(false);
    });
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button>
          <Plus className="size-4" />
          Add account
        </Button>
      </DialogTrigger>
      <DialogContent>
        <form onSubmit={submit} className="space-y-4">
          <DialogHeader>
            <DialogTitle>Add Telegram account</DialogTitle>
            <DialogDescription>It goes into the pool as available.</DialogDescription>
          </DialogHeader>
          <ModelSelect models={models} value={form.modelId} onChange={set("modelId")} />
          <div className="space-y-2">
            <Label htmlFor="acct-username">Telegram username</Label>
            <Input
              id="acct-username"
              value={form.username}
              onChange={(e) => set("username")(e.target.value)}
              placeholder="@sophiejetlag"
              autoCapitalize="none"
              autoComplete="off"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="acct-phone">Phone</Label>
            <Input
              id="acct-phone"
              value={form.phone}
              onChange={(e) => set("phone")(e.target.value)}
              placeholder="+13095550100"
              inputMode="tel"
              autoComplete="off"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="acct-link">Link (optional)</Label>
            <Input
              id="acct-link"
              value={form.link}
              onChange={(e) => set("link")(e.target.value)}
              placeholder="Defaults to https://t.me/<username>"
              autoCapitalize="none"
              autoComplete="off"
            />
          </div>
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button type="submit" disabled={pending || !form.modelId || !form.username || !form.phone}>
              {pending ? "Adding…" : "Add account"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function ImportAccountsDialog({ models }: { models: ModelOption[] }) {
  const [open, setOpen] = useState(false);
  const [modelId, setModelId] = useState("");
  const [text, setText] = useState("");
  const [summary, setSummary] = useState<ImportSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function close(o: boolean) {
    setOpen(o);
    if (!o) {
      setSummary(null);
      setError(null);
    }
  }

  async function loadFile(file: File | undefined) {
    if (!file) return;
    if (file.size > 1_000_000) return setError("File is too large (max 1 MB).");
    setText(await file.text());
  }

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    startTransition(async () => {
      const result = await importPoolAction({ modelId, text });
      if (!result.ok) return setError(result.error);
      setSummary(result.data);
      setText("");
    });
  }

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogTrigger asChild>
        <Button variant="outline">
          <Upload className="size-4" />
          Bulk import
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[90dvh] overflow-y-auto">
        {summary ? (
          <div className="space-y-4">
            <DialogHeader>
              <DialogTitle>Import finished</DialogTitle>
              <DialogDescription>
                Added {summary.added} {summary.added === 1 ? "account" : "accounts"}
                {summary.rejects.length > 0 && `, skipped ${summary.rejects.length}`}.
              </DialogDescription>
            </DialogHeader>
            {summary.rejects.length > 0 && (
              <ul className="max-h-64 space-y-1 overflow-y-auto rounded-lg border p-3 text-sm">
                {summary.rejects.map((r) => (
                  <li key={`${r.line}-${r.raw}`}>
                    <span className="text-muted-foreground">Line {r.line}:</span> <code className="break-all">{r.raw}</code>{" "}
                    <span className="text-destructive">({r.reason})</span>
                  </li>
                ))}
              </ul>
            )}
            <DialogFooter>
              <Button onClick={() => setSummary(null)} variant="outline">
                Import more
              </Button>
              <Button onClick={() => close(false)}>Done</Button>
            </DialogFooter>
          </div>
        ) : (
          <form onSubmit={submit} className="space-y-4">
            <DialogHeader>
              <DialogTitle>Bulk import accounts</DialogTitle>
              <DialogDescription>
                One per line: <code>username, phone, link</code>. Link is optional. Duplicates are skipped.
              </DialogDescription>
            </DialogHeader>
            <ModelSelect models={models} value={modelId} onChange={setModelId} />
            <div className="space-y-2">
              <Label htmlFor="import-text">Accounts</Label>
              <Textarea
                id="import-text"
                value={text}
                onChange={(e) => setText(e.target.value)}
                rows={8}
                placeholder={"sophiejetlag, +13095550100\nsophie_travels, +13095550101, https://t.me/sophie_travels"}
                className="font-mono text-xs"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="import-file">…or upload a CSV</Label>
              <Input id="import-file" type="file" accept=".csv,.txt,text/csv,text/plain" onChange={(e) => loadFile(e.target.files?.[0])} />
            </div>
            {error && (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}
            <DialogFooter>
              <Button type="submit" disabled={pending || !modelId || !text.trim()}>
                {pending ? "Importing…" : "Import"}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

const NOTIFY_TEXT: Record<string, string> = {
  sent: "they were notified on Telegram",
  not_linked: "they haven't linked Telegram yet, so tell them yourself",
  bot_not_configured: "the bot isn't set up, so tell them yourself",
  failed: "the Telegram message failed, so tell them yourself",
};

export function AccountActions({
  accountId,
  username,
  status,
  holder,
}: {
  accountId: string;
  username: string;
  status: string;
  holder: string | null;
}) {
  const [confirm, setConfirm] = useState<"BANNED" | "RETIRED" | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const out = status === "BANNED" || status === "RETIRED";

  function take(s: "BANNED" | "RETIRED") {
    startTransition(async () => {
      const r = await takeAccountOutOfServiceAction(accountId, s);
      setConfirm(null);
      if (!r.ok) return setMsg(r.error);
      const d = r.data;
      setMsg(
        !d.vaId
          ? `@${username} ${s === "BANNED" ? "banned" : "retired"}.`
          : d.replacement
            ? `@${holder} moved to @${d.replacement}; ${NOTIFY_TEXT[d.notified ?? "failed"]}.`
            : `@${holder} has no account now: the pool is empty. Their Lead VA can assign one once you add more.`,
      );
    });
  }

  if (confirm) {
    return (
      <span className="flex flex-wrap items-center gap-2 text-xs">
        <span className="text-muted-foreground">
          {confirm === "BANNED" ? "Ban" : "Retire"} @{username}?{holder && ` @${holder} gets the next free account.`}
        </span>
        <Button size="sm" variant="destructive" disabled={pending} onClick={() => take(confirm)}>
          {pending ? "…" : "Confirm"}
        </Button>
        <Button size="sm" variant="ghost" disabled={pending} onClick={() => setConfirm(null)}>
          Cancel
        </Button>
      </span>
    );
  }
  return (
    <span className="flex flex-wrap items-center gap-1">
      {msg && <span className="text-xs text-muted-foreground">{msg}</span>}
      {out ? (
        <Button
          size="sm"
          variant="outline"
          disabled={pending}
          onClick={() =>
            startTransition(async () => {
              const r = await restoreAccountAction(accountId);
              setMsg(r.ok ? `@${username} is available again.` : r.error);
            })
          }
        >
          Restore
        </Button>
      ) : (
        <>
          <Button size="sm" variant="ghost" className="text-destructive hover:text-destructive" onClick={() => setConfirm("BANNED")}>
            Ban
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setConfirm("RETIRED")}>
            Retire
          </Button>
        </>
      )}
    </span>
  );
}
