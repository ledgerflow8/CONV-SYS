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
import { checkWallet, isAptosAddress, WALLET_NETWORK } from "@/lib/wallet";


export function WalletDialog({ current, currency, trigger }: { current: string | null; currency: string; trigger?: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState(current ?? "");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const v = value.trim();
  const checked = v === "" ? null : checkWallet(v);
  const hint = checked && !checked.ok ? checked.error : null;
  // An address saved before the move to Aptos isn't kept as a starting value: it can't be saved again.
  const usable = isAptosAddress(current) ? current : null;

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!checked?.ok) return;
    setError(null);
    startTransition(async () => {
      const r = await setWalletAction(checked.address);
      if (!r.ok) return setError(r.error);
      setOpen(false);
    });
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (o) setValue(usable ?? "");
        setError(null);
      }}
    >
      <DialogTrigger asChild>
        {trigger ?? (
          <Button size="sm" variant={current ? "outline" : "default"}>
            <Wallet className="size-4" />
            {usable ? "Change wallet" : `Add ${WALLET_NETWORK} wallet`}
          </Button>
        )}
      </DialogTrigger>
      <DialogContent>
        <form onSubmit={submit} className="space-y-4">
          <DialogHeader>
            <DialogTitle>Payout wallet ({WALLET_NETWORK})</DialogTitle>
            <DialogDescription>
              Weekly payouts are sent here in {currency} on the {WALLET_NETWORK} network. Paste the address from your {WALLET_NETWORK}{" "}
              wallet and double-check it: payments to a wrong address can&apos;t be reversed.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="wallet">{WALLET_NETWORK} wallet address</Label>
            <Input
              id="wallet"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder="0x… (64 characters)"
              autoCapitalize="none"
              autoComplete="off"
              spellCheck={false}
              className="font-mono text-sm"
              aria-invalid={!!hint}
              aria-describedby="wallet-hint"
            />
            <p id="wallet-hint" className={hint ? "text-sm text-destructive" : "text-xs text-muted-foreground"}>
              {hint ??
                (checked?.ok && checked.address !== v.toLowerCase()
                  ? `Saved as ${checked.address} (the full 64-character form).`
                  : "Changes apply to weeks that haven't been locked yet.")}
            </p>
          </div>
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button type="submit" disabled={!checked?.ok || checked.address === usable || pending}>
              {pending ? "Saving…" : "Save wallet"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
