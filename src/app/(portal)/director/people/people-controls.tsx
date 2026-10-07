"use client";

import { useState, useTransition } from "react";
import type { UserStatus } from "@prisma/client";
import { Button } from "@/components/ui/button";
import { CreatePersonDialog } from "@/components/create-person-dialog";
import { RegeneratePasswordButton } from "@/components/regenerate-password-button";
import { createLeadManagerAction, regeneratePasswordAction, setLeadManagerStatusAction } from "../actions";

export function CreateLeadManager() {
  return (
    <CreatePersonDialog
      role="LEAD_MANAGER"
      roleLabel="Lead Manager"
      whatHappensNext={[
        "Their account is created with a generated password.",
        "You'll see the username and password once. Send them privately.",
        "They log in and start creating Lead VAs.",
      ]}
      create={(input) => createLeadManagerAction(input)}
    />
  );
}

export function LeadManagerActions({ userId, username, status }: { userId: string; username: string; status: UserStatus }) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const disabled = status === "DISABLED";

  return (
    <div className="flex flex-wrap items-center gap-2">
      {!disabled && <RegeneratePasswordButton userId={userId} username={username} regenerate={regeneratePasswordAction} />}
      <Button
        size="sm"
        variant={disabled ? "outline" : "ghost"}
        className={disabled ? undefined : "text-destructive hover:text-destructive"}
        disabled={pending}
        onClick={() =>
          startTransition(async () => {
            const result = await setLeadManagerStatusAction(userId, disabled ? "ACTIVE" : "DISABLED");
            setError(result.ok ? null : result.error);
          })
        }
      >
        {pending ? "…" : disabled ? "Enable" : "Disable"}
      </Button>
      {error && <span className="text-xs text-destructive">{error}</span>}
    </div>
  );
}
