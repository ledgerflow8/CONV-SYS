"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { createModelAction, setModelActiveAction } from "../actions";

export function AddModelForm() {
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    startTransition(async () => {
      const result = await createModelAction(name);
      if (!result.ok) return setError(result.error);
      setName("");
    });
  }

  return (
    <form onSubmit={submit} className="space-y-2">
      <div className="flex gap-2">
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Model name, e.g. Sophie"
          aria-label="Model name"
          maxLength={40}
        />
        <Button type="submit" disabled={pending || !name.trim()}>
          {pending ? "Adding…" : "Add"}
        </Button>
      </div>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </form>
  );
}

export function ToggleModelButton({ modelId, active, name }: { modelId: string; active: boolean; name: string }) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="flex items-center gap-2">
      {error && <span className="text-xs text-destructive">{error}</span>}
      <Button
        size="sm"
        variant="outline"
        disabled={pending}
        aria-label={`${active ? "Deactivate" : "Activate"} ${name}`}
        onClick={() =>
          startTransition(async () => {
            const result = await setModelActiveAction(modelId, !active);
            setError(result.ok ? null : result.error);
          })
        }
      >
        {pending ? "…" : active ? "Deactivate" : "Activate"}
      </Button>
    </div>
  );
}
