"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import type { SettingsFormErrors, SettingsFormInput } from "@/lib/settings-form";
import { saveSettingsAction } from "../actions";

type Field = keyof SettingsFormInput;

export function SettingsForm({
  initial,
  timezones,
}: {
  initial: SettingsFormInput;
  timezones: { value: string; label: string }[];
}) {
  const [form, setForm] = useState(initial);
  const [errors, setErrors] = useState<SettingsFormErrors>({});
  const [status, setStatus] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const dirty = JSON.stringify(form) !== JSON.stringify(initial);
  const set = (k: Field) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setStatus(null);
    startTransition(async () => {
      const result = await saveSettingsAction(form);
      if (result.ok) {
        setErrors({});
        setStatus(result.changed.length ? `Saved: ${result.changed.join(", ")}` : "Nothing changed.");
      } else {
        setErrors(result.errors ?? {});
        setStatus(result.error ?? "Fix the highlighted fields.");
      }
    });
  }

  const field = (k: Field, label: string, props: React.ComponentProps<typeof Input> = {}) => (
    <div className="space-y-1.5">
      <Label htmlFor={k}>{label}</Label>
      <Input id={k} value={form[k]} onChange={set(k)} aria-invalid={!!errors[k]} {...props} />
      {errors[k] && <p className="text-sm text-destructive">{errors[k]}</p>}
    </div>
  );

  return (
    <form onSubmit={submit} className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Rates per qualified convo</CardTitle>
          <CardDescription>In dollars. Each convo keeps the rate it qualified at, so changes only affect new ones.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-3">
          {field("rateVa", "VA", { inputMode: "decimal" })}
          {field("rateLeadVa", "Lead VA", { inputMode: "decimal" })}
          {field("rateLm", "Lead Manager", { inputMode: "decimal" })}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Qualification</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {field("tier1Countries", "Tier 1 countries (2-letter codes)", { placeholder: "US, CA, GB, AU, NZ, IE" })}
          <div className="space-y-1.5">
            <Label htmlFor="blockedDomains">Blocked source domains (one per line)</Label>
            <Textarea
              id="blockedDomains"
              value={form.blockedDomains}
              onChange={set("blockedDomains")}
              rows={5}
              placeholder={"spam-site.com\nbad-forum.net"}
              className="font-mono text-sm"
              aria-invalid={!!errors.blockedDomains}
            />
            <p className={errors.blockedDomains ? "text-sm text-destructive" : "text-xs text-muted-foreground"}>
              {errors.blockedDomains ?? "Subdomains are blocked too. Clicks from these sources are logged as blocked."}
            </p>
          </div>
          {field("clickMatchWindowMin", "Click-match window (minutes)", { inputMode: "numeric" })}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Payouts &amp; support</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="timezone">Timezone (pay week Monday–Sunday)</Label>
            <select
              id="timezone"
              value={form.timezone}
              onChange={set("timezone")}
              className="h-9 w-full rounded-md border bg-background px-3 text-sm"
            >
              {timezones.map((tz) => (
                <option key={tz.value} value={tz.value}>
                  {tz.label}
                </option>
              ))}
            </select>
            {errors.timezone && <p className="text-sm text-destructive">{errors.timezone}</p>}
          </div>
          {field("payoutCurrency", "Payout currency (label only)", { placeholder: "USDT (TRC-20)" })}
          {field("supportTelegram", "Support Telegram for “Report a Problem”", { placeholder: "@support_handle" })}
        </CardContent>
      </Card>

      <div className="sticky bottom-24 flex items-center gap-3 rounded-xl border bg-background/95 p-3 shadow-sm backdrop-blur">
        <Button type="submit" disabled={pending || !dirty}>
          {pending ? "Saving…" : "Save settings"}
        </Button>
        {status && (
          <p role="status" className="text-sm text-muted-foreground">
            {status}
          </p>
        )}
      </div>
    </form>
  );
}
