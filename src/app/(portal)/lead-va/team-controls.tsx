"use client";

import { useState, useTransition } from "react";
import { Link2, Plus, TriangleAlert, UserMinus } from "lucide-react";
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
import { CopyButton } from "@/components/copy-button";
import { portalUsername } from "@/lib/usernames";
import type { Invite } from "@/lib/team";
import { addVaAction, fireVaAction, regenerateInviteAction } from "./actions";

function InviteDialog({ invite, onClose }: { invite: Invite | null; onClose: () => void }) {
  return (
    <Dialog open={invite !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Send this to your VA</DialogTitle>
          {invite?.rehired && (
            <p className="text-sm font-medium">
              @{invite.username} worked here before, so their old login was re-activated on your team.
            </p>
          )}
          <DialogDescription>
            When @{invite?.username} opens it, the bot sends them their login, Telegram account and tracking link. It
            works once and expires {invite && formatExpiry(invite.expiresAt)}.
          </DialogDescription>
        </DialogHeader>
        {invite?.url ? (
          <div className="flex items-center gap-2 rounded-lg border bg-muted/40 p-3">
            <code className="min-w-0 flex-1 text-sm break-all">{invite.url}</code>
            <CopyButton value={invite.url} />
          </div>
        ) : (
          <div className="flex gap-2 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-100">
            <TriangleAlert className="mt-0.5 size-4 shrink-0" />
            <p>
              The bot isn&apos;t set up yet, so there&apos;s no link to send. The VA is created; use{" "}
              <strong>New invite</strong> on their row once the bot is live.
            </p>
          </div>
        )}
        <DialogFooter>
          <Button onClick={onClose}>Done</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function formatExpiry(d: Date) {
  return `on ${new Date(d).toLocaleString(undefined, { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}`;
}

export function AddVaButton({ poolEmpty }: { poolEmpty: boolean }) {
  const [open, setOpen] = useState(false);
  const [handle, setHandle] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [invite, setInvite] = useState<Invite | null>(null);
  const [pending, startTransition] = useTransition();

  const trimmed = handle.trim().replace(/^@/, "");
  const preview = portalUsername(handle, "VA");
  const hint =
    trimmed.length === 0 ? null : trimmed.length < 5 ? "At least 5 characters." : !preview ? "Letters, numbers and underscores only, starting with a letter." : null;

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!preview || pending) return;
    setError(null);
    startTransition(async () => {
      const result = await addVaAction(handle);
      if (!result.ok) return setError(result.error);
      setOpen(false);
      setHandle("");
      setInvite(result.data);
    });
  }

  return (
    <>
      <Dialog
        open={open}
        onOpenChange={(o) => {
          setOpen(o);
          if (!o) setError(null);
        }}
      >
        <DialogTrigger asChild>
          <Button className="h-11 w-full sm:w-auto" disabled={poolEmpty}>
            <Plus className="size-4" />
            Add VA
          </Button>
        </DialogTrigger>
        <DialogContent>
          <form onSubmit={submit} className="space-y-4">
            <DialogHeader>
              <DialogTitle>Add VA</DialogTitle>
              <DialogDescription>
                They get the next free Telegram account for your model and their own tracking link.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-2">
              <Label htmlFor="va-handle">VA&apos;s Telegram username</Label>
              <Input
                id="va-handle"
                value={handle}
                onChange={(e) => setHandle(e.target.value)}
                placeholder="@username"
                autoCapitalize="none"
                autoComplete="off"
                aria-invalid={!!hint}
                aria-describedby="va-handle-hint"
              />
              <p id="va-handle-hint" className={hint ? "text-sm text-destructive" : "text-sm text-muted-foreground"}>
                {hint ?? (preview ? `Portal username: @${preview}` : "Min 5 characters.")}
              </p>
            </div>
            {error && (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}
            <DialogFooter>
              <Button type="submit" disabled={!preview || pending}>
                {pending ? "Adding…" : "Add VA"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      <InviteDialog invite={invite} onClose={() => setInvite(null)} />
    </>
  );
}

export function VaRowActions({ vaId, username, joined }: { vaId: string; username: string; joined: boolean }) {
  const [confirmFire, setConfirmFire] = useState(false);
  const [confirmInvite, setConfirmInvite] = useState(false);
  const [invite, setInvite] = useState<Invite | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function newInvite() {
    setError(null);
    startTransition(async () => {
      const result = await regenerateInviteAction(vaId);
      setConfirmInvite(false);
      if (!result.ok) return setError(result.error);
      setInvite(result.data);
    });
  }

  function fire() {
    setError(null);
    startTransition(async () => {
      const result = await fireVaAction(vaId);
      if (!result.ok) {
        setConfirmFire(false);
        setError(result.error);
      }
    });
  }

  return (
    <div className="flex flex-wrap items-center justify-end gap-2">
      {confirmFire ? (
        <>
          <span className="text-xs text-muted-foreground">Fire @{username}?</span>
          <Button size="sm" variant="destructive" onClick={fire} disabled={pending}>
            {pending ? "…" : "Fire"}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setConfirmFire(false)} disabled={pending}>
            Cancel
          </Button>
        </>
      ) : confirmInvite ? (
        <>
          <span className="text-xs text-muted-foreground">{joined ? "Resets their password." : "Old link stops working."}</span>
          <Button size="sm" onClick={newInvite} disabled={pending}>
            {pending ? "…" : "Confirm"}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setConfirmInvite(false)} disabled={pending}>
            Cancel
          </Button>
        </>
      ) : (
        <>
          <Button size="sm" variant="outline" onClick={() => setConfirmInvite(true)} aria-label={`New invite for ${username}`}>
            <Link2 className="size-4" />
            New invite
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="text-destructive hover:text-destructive"
            onClick={() => setConfirmFire(true)}
            aria-label={`Fire ${username}`}
          >
            <UserMinus className="size-4" />
            Fire
          </Button>
        </>
      )}
      {error && <span className="w-full text-right text-xs text-destructive">{error}</span>}
      <InviteDialog invite={invite} onClose={() => setInvite(null)} />
    </div>
  );
}
