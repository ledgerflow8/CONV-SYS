"use client";

import { useState, useTransition } from "react";
import { KeyRound } from "lucide-react";
import { Button } from "@/components/ui/button";
import { CredentialsDialog } from "@/components/credentials-dialog";
import type { Result } from "@/lib/action-result";
import type { Credentials } from "@/lib/people";

export function RegeneratePasswordButton({
  userId,
  username,
  regenerate,
}: {
  userId: string;
  username: string;
  regenerate: (userId: string) => Promise<Result<Credentials>>;
}) {
  const [confirming, setConfirming] = useState(false);
  const [credentials, setCredentials] = useState<Credentials | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function run() {
    setError(null);
    startTransition(async () => {
      const result = await regenerate(userId);
      setConfirming(false);
      if (!result.ok) return setError(result.error);
      setCredentials(result.data);
    });
  }

  return (
    <>
      {confirming ? (
        <span className="inline-flex items-center gap-1">
          <Button size="sm" variant="destructive" onClick={run} disabled={pending}>
            {pending ? "…" : "Confirm"}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setConfirming(false)} disabled={pending}>
            Cancel
          </Button>
        </span>
      ) : (
        <Button size="sm" variant="outline" onClick={() => setConfirming(true)} aria-label={`New password for ${username}`}>
          <KeyRound className="size-4" />
          New password
        </Button>
      )}
      {error && <span className="text-xs text-destructive">{error}</span>}
      <CredentialsDialog
        credentials={credentials}
        title={`New password for @${username}`}
        onDone={() => setCredentials(null)}
      />
    </>
  );
}
