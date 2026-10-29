"use client";

import { useState, useTransition } from "react";
import { Lock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { formatCents } from "@/lib/money";
import {
  clearAllWalletsAction,
  lockFinishedWeeksAction,
  lockWeekAction,
  markPayoutFailedAction,
  markPayoutPaidAction,
  refreshPayoutWalletAction,
} from "../actions";

export function LockFinishedWeeksButton({ due }: { due: number }) {
  const [pending, startTransition] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);
  return (
    <>
      <Button
        variant="outline"
        disabled={pending || due === 0}
        onClick={() =>
          startTransition(async () => {
            const r = await lockFinishedWeeksAction();
            setMsg(r.ok ? `Locked ${r.data.length} week(s), ${r.data.reduce((n, w) => n + w.payouts, 0)} payouts.` : r.error);
          })
        }
      >
        <Lock className="size-4" />
        {pending ? "Locking…" : "Lock finished weeks"}
      </Button>
      {msg && <span className="text-sm text-muted-foreground">{msg}</span>}
    </>
  );
}

export function LockWeekButton({ weekId }: { weekId: string }) {
  const [confirm, setConfirm] = useState(false);
  const [pending, startTransition] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);

  if (!confirm) {
    return (
      <Button onClick={() => setConfirm(true)}>
        <Lock className="size-4" /> Lock week
      </Button>
    );
  }
  return (
    <span className="flex flex-wrap items-center gap-2">
      <span className="text-sm text-muted-foreground">Locking is permanent. Payouts are generated from it.</span>
      <Button
        disabled={pending}
        onClick={() =>
          startTransition(async () => {
            const r = await lockWeekAction(weekId);
            if (!r.ok) setMsg(r.error);
            else setMsg(`${r.data.payouts} payouts · ${formatCents(r.data.totalCents)}`);
          })
        }
      >
        {pending ? "Locking…" : "Confirm lock"}
      </Button>
      <Button variant="ghost" onClick={() => setConfirm(false)} disabled={pending}>
        Cancel
      </Button>
      {msg && <span className="text-sm">{msg}</span>}
    </span>
  );
}

export function PayoutRowActions({
  payoutId,
  status,
  hasWallet,
  canUseCurrentWallet,
}: {
  payoutId: string;
  status: string;
  hasWallet: boolean;
  canUseCurrentWallet: boolean;
}) {
  const [hash, setHash] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const validHash = /^(0x)?[0-9a-fA-F]{64}$/.test(hash.trim());

  const run = (fn: () => Promise<{ ok: boolean; error?: string }>) =>
    startTransition(async () => {
      const r = await fn();
      setError(r.ok ? null : (r.error ?? "Something went wrong."));
      if (r.ok) setHash("");
    });

  return (
    <div className="space-y-1">
      <div className="flex flex-wrap items-center gap-2">
        {hasWallet && (
          <>
            <Input
              value={hash}
              onChange={(e) => setHash(e.target.value)}
              placeholder="Paste tx hash"
              aria-label="Transaction hash"
              className="h-8 min-w-0 flex-1 font-mono text-xs"
              spellCheck={false}
            />
            <Button size="sm" disabled={!validHash || pending} onClick={() => run(() => markPayoutPaidAction(payoutId, hash.trim()))}>
              Mark paid
            </Button>
          </>
        )}
        {canUseCurrentWallet && (
          <Button size="sm" variant="outline" disabled={pending} onClick={() => run(() => refreshPayoutWalletAction(payoutId))}>
            Use current wallet
          </Button>
        )}
        {status === "PENDING" && (
          <Button size="sm" variant="ghost" className="text-destructive hover:text-destructive" disabled={pending} onClick={() => run(() => markPayoutFailedAction(payoutId))}>
            Failed
          </Button>
        )}
      </div>
      {hash && !validHash && <p className="text-xs text-destructive">A tx hash is 64 hex characters (optionally starting 0x).</p>}
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}

/** Two steps: the counts and what happens, then Confirm. */
export function ClearWalletsButton({ users, unpaid }: { users: number; unpaid: number }) {
  const [confirm, setConfirm] = useState(false);
  const [pending, startTransition] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);

  if (!confirm) {
    return (
      <div className="space-y-2">
        <Button variant="outline" className="border-destructive/50 text-destructive" disabled={users + unpaid === 0} onClick={() => setConfirm(true)}>
          Clear all wallet addresses
        </Button>
        {msg && <p className="text-sm">{msg}</p>}
      </div>
    );
  }
  return (
    <div className="space-y-2 rounded-lg border border-destructive/40 p-3 text-sm">
      <p>
        This removes the saved wallet of <strong>{users}</strong> {users === 1 ? "person" : "people"} and the old wallet on{" "}
        <strong>{unpaid}</strong> unpaid payout {unpaid === 1 ? "line" : "lines"}. Everyone sees the &ldquo;Payout address missing&rdquo;
        banner until they add an Aptos address; then use &ldquo;Use current wallet&rdquo; on their unpaid lines. Paid lines keep their
        wallet. The old addresses stay in the audit log.
      </p>
      <div className="flex gap-2">
        <Button
          variant="destructive"
          disabled={pending}
          onClick={() =>
            startTransition(async () => {
              const r = await clearAllWalletsAction();
              setMsg(r.ok ? `Cleared ${r.data.users} wallets and ${r.data.payouts} unpaid payout lines.` : r.error);
              setConfirm(false);
            })
          }
        >
          {pending ? "Clearing…" : "Confirm: clear all"}
        </Button>
        <Button variant="ghost" disabled={pending} onClick={() => setConfirm(false)}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
