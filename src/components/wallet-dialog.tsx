"use client";

import { useState, useTransition } from "react";
import { Wallet } from "lucide-react";
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
import { setWalletAction } from "@/app/(portal)/wallet-actions";

const WALLET = /^0x[0-9a-fA-F]{40}$/;

export function WalletDialog({ current, currency, trigger }: { current: string | null; currency: string; trigger?: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState(current ?? "");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const v = value.trim();
  const hint = v === "" ? null : WALLET.test(v) ? null : "Must be 0x followed by 40 hex characters (0–9, a–f).";

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!WALLET.test(v)) return;
    setError(null);
    startTransition(async () => {
      const r = await setWalletAction(v);
      if (!r.ok) return setError(r.error);
      setOpen(false);
    });
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (o) setValue(current ?? "");
        setError(null);
      }}
    >
      <DialogTrigger asChild>
        {trigger ?? (
          <Button size="sm" variant={current ? "outline" : "default"}>
            <Wallet className="size-4" />
            {current ? "Change wallet" : "Add wallet"}
          </Button>
        )}
      </DialogTrigger>
      <DialogContent>
        <form onSubmit={submit} className="space-y-4">
          <DialogHeader>
            <DialogTitle>Payout wallet</DialogTitle>
            <DialogDescription>
              Weekly payouts are sent here in {currency}. Double-check it: payments to a wrong address can&apos;t be reversed.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="wallet">Wallet address</Label>
            <Input
              id="wallet"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder="0x…"
              autoCapitalize="none"
              autoComplete="off"
              spellCheck={false}
              className="font-mono text-sm"
              aria-invalid={!!hint}
              aria-describedby="wallet-hint"
            />
            <p id="wallet-hint" className={hint ? "text-sm text-destructive" : "text-xs text-muted-foreground"}>
              {hint ?? "Changes apply to weeks that haven't been locked yet."}
            </p>
          </div>
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button type="submit" disabled={!WALLET.test(v) || v === current || pending}>
              {pending ? "Saving…" : "Save wallet"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
