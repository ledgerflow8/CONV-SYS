"use client";

import { CreatePersonDialog } from "@/components/create-person-dialog";
import { RegeneratePasswordButton } from "@/components/regenerate-password-button";
import { createLeadVaAction, regenerateLeadVaPasswordAction } from "./actions";

export function CreateLeadVa({ models }: { models: { id: string; name: string }[] }) {
  return (
    <CreatePersonDialog
      role="LEAD_VA"
      roleLabel="Lead VA"
      models={models}
      whatHappensNext={[
        "Their account is created with a generated password.",
        "You'll see the username and password once. Send them privately.",
        "They log in, set their payout wallet, and start adding VAs for this model.",
      ]}
      create={(input) => createLeadVaAction(input)}
    />
  );
}

export function LeadVaPasswordButton({ userId, username }: { userId: string; username: string }) {
  return <RegeneratePasswordButton userId={userId} username={username} regenerate={regenerateLeadVaPasswordAction} />;
}
