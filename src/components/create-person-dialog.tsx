"use client";

import { useState, useTransition } from "react";
import { Plus } from "lucide-react";
import type { Role } from "@prisma/client";
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
import { CredentialsDialog } from "@/components/credentials-dialog";
import type { Result } from "@/lib/action-result";
import type { Credentials } from "@/lib/people";
import { portalUsername } from "@/lib/usernames";

type Props = {
  role: Extract<Role, "LEAD_MANAGER" | "LEAD_VA">;
  roleLabel: string;
  models?: { id: string; name: string }[]; // shown when the new account needs a model
  whatHappensNext: string[];
  create: (input: { handle: string; modelId?: string }) => Promise<Result<Credentials>>;
};

export function CreatePersonDialog({ role, roleLabel, models, whatHappensNext, create }: Props) {
  const [open, setOpen] = useState(false);
  const [handle, setHandle] = useState("");
  const [modelId, setModelId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [credentials, setCredentials] = useState<Credentials | null>(null);
  const [pending, startTransition] = useTransition();

  const trimmed = handle.trim().replace(/^@/, "");
  const preview = portalUsername(handle, role);
  const handleError =
    trimmed.length === 0
      ? null
      : trimmed.length < 5
        ? "At least 5 characters."
        : !preview
          ? "Letters, numbers and underscores only, starting with a letter."
          : null;
  const needsModel = models !== undefined;
  const canSubmit = !!preview && (!needsModel || !!modelId) && !pending;

  function reset() {
    setHandle("");
    setModelId("");
    setError(null);
  }

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    setError(null);
    startTransition(async () => {
      const result = await create({ handle, modelId: needsModel ? modelId : undefined });
      if (!result.ok) return setError(result.error);
      setOpen(false);
      reset();
      setCredentials(result.data);
    });
  }

  return (
    <>
      <Dialog
        open={open}
        onOpenChange={(o) => {
          setOpen(o);
          if (!o) reset();
        }}
      >
        <DialogTrigger asChild>
          <Button className="h-11 w-full sm:w-auto">
            <Plus className="size-4" />
            Create {roleLabel}
          </Button>
        </DialogTrigger>
        <DialogContent>
          <form onSubmit={submit} className="space-y-4">
            <DialogHeader>
              <DialogTitle>Create {roleLabel}</DialogTitle>
              <DialogDescription>Their portal username is built from their Telegram username.</DialogDescription>
            </DialogHeader>

            <div className="space-y-2">
              <Label htmlFor="handle">Telegram username</Label>
              <Input
                id="handle"
                value={handle}
                onChange={(e) => setHandle(e.target.value)}
                placeholder="@username"
                autoCapitalize="none"
                autoComplete="off"
                aria-invalid={!!handleError}
                aria-describedby="handle-hint"
              />
              <p id="handle-hint" className={handleError ? "text-sm text-destructive" : "text-sm text-muted-foreground"}>
                {handleError ?? (preview ? `Portal username: @${preview}` : "Min 5 characters.")}
              </p>
            </div>

            {needsModel && (
              <div className="space-y-2">
                <Label htmlFor="model">Model</Label>
                <Select value={modelId} onValueChange={setModelId}>
                  <SelectTrigger id="model" className="w-full">
                    <SelectValue placeholder={models.length ? "Pick the team's model" : "No active models"} />
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
            )}

            <div className="rounded-lg border bg-muted/40 p-3 text-sm">
              <p className="mb-1 font-medium">What happens next</p>
              <ol className="list-decimal space-y-1 pl-5 text-muted-foreground">
                {whatHappensNext.map((step) => (
                  <li key={step}>{step}</li>
                ))}
              </ol>
            </div>

            {error && (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}

            <DialogFooter>
              <Button type="submit" className="w-full sm:w-auto" disabled={!canSubmit}>
                {pending ? "Creating…" : `Create ${roleLabel}`}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <CredentialsDialog
        credentials={credentials}
        title={`${roleLabel} created`}
        onDone={() => setCredentials(null)}
      />
    </>
  );
}
