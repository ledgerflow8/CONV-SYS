"use client";

import { useState } from "react";
import { TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { CopyButton } from "@/components/copy-button";
import type { Credentials } from "@/lib/people";

/**
 * Shows a generated password exactly once. It can't be dismissed until the
 * person confirms they've saved it — there is no password reset.
 */
export function CredentialsDialog({
  credentials,
  title,
  onDone,
}: {
  credentials: Credentials | null;
  title: string;
  onDone: () => void;
}) {
  const [saved, setSaved] = useState(false);

  function done() {
    setSaved(false);
    onDone();
  }

  return (
    <Dialog open={credentials !== null} onOpenChange={(open) => !open && saved && done()}>
      <DialogContent
        showCloseButton={false}
        onEscapeKeyDown={(e) => !saved && e.preventDefault()}
        onInteractOutside={(e) => e.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>Send these login details to them privately.</DialogDescription>
        </DialogHeader>

        {credentials && (
          <dl className="space-y-3">
            <Row label="Username" value={credentials.username} />
            <Row label="Password" value={credentials.password} mono />
            {credentials.model && <Row label="Model" value={credentials.model} copy={false} />}
          </dl>
        )}

        <div className="flex gap-2 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-100">
          <TriangleAlert className="mt-0.5 size-4 shrink-0" />
          <p>This password won&apos;t be shown again and there&apos;s no reset. Save it now.</p>
        </div>

        <div className="flex items-center gap-2">
          <Checkbox id="saved" checked={saved} onCheckedChange={(v) => setSaved(v === true)} />
          <Label htmlFor="saved">I&apos;ve saved the password</Label>
        </div>

        <DialogFooter>
          <Button type="button" className="w-full sm:w-auto" disabled={!saved} onClick={done}>
            Done
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Row({ label, value, mono, copy = true }: { label: string; value: string; mono?: boolean; copy?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-lg border bg-muted/40 px-3 py-2">
      <div className="min-w-0">
        <dt className="text-xs text-muted-foreground">{label}</dt>
        <dd className={mono ? "font-mono text-sm break-all" : "text-sm font-medium break-all"}>{value}</dd>
      </div>
      {copy && <CopyButton value={value} />}
    </div>
  );
}
