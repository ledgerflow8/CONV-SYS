"use client";

// Fire / move team / fire inactive / rename: every bulk or destructive action previews first and
// needs an explicit confirm (client feedback 2026-10-18).
import { useState, useTransition } from "react";
import { ArrowRightLeft, Pencil, UserMinus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { FirePlan, InactiveVa, MovePlan } from "@/lib/org";
import {
  bulkMoveAction,
  findInactiveAction,
  fireInactiveAction,
  fireUserAction,
  moveTeamAction,
  planBulkMoveAction,
  planFireAction,
  planTeamMoveAction,
} from "@/app/(portal)/org-actions";
import { renameModelAction } from "@/app/(portal)/director/actions";

type ModelOption = { id: string; name: string };
const ROLE: Record<string, string> = { LEAD_MANAGER: "Lead Manager", LEAD_VA: "Lead VA", VA: "VA" };
const select = "h-9 w-full rounded-md border bg-background px-3 text-sm";
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

// ── Fire ─────────────────────────────────────────────────────────────────

export function FireButton({ targetId, username }: { targetId: string; username: string }) {
  const [open, setOpen] = useState(false);
  const [plan, setPlan] = useState<FirePlan | null>(null);
  const [choice, setChoice] = useState<"fire" | "move">("move");
  const [moveTo, setMoveTo] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, start] = useTransition();

  function openDialog() {
    setOpen(true);
    setPlan(null);
    setMsg(null);
    setMoveTo("");
    start(async () => {
      const r = await planFireAction(targetId);
      if (!r.ok) return setMsg({ ok: false, text: r.error });
      setPlan(r.data);
      setChoice(r.data.moveTargets.length ? "move" : "fire");
    });
  }

  function confirm() {
    if (!plan) return;
    const reports = plan.under.length ? (choice === "fire" ? "fire" : { moveTo }) : null;
    start(async () => {
      const r = await fireUserAction(targetId, reports);
      if (!r.ok) return setMsg({ ok: false, text: r.error });
      const d = r.data;
      setMsg({
        ok: true,
        text: `Fired ${plural(d.fired, "person", "people")}${d.moved ? `, moved ${d.moved}` : ""}${d.needAccount ? `; ${d.needAccount} need an account` : ""}.`,
      });
    });
  }

  const under = plan?.under.length ?? 0;
  const canConfirm = !!plan && (!under || choice === "fire" || !!moveTo) && !msg?.ok;
  return (
    <>
      <Button size="sm" variant="outline" className="border-destructive/50 text-destructive hover:bg-destructive/10 hover:text-destructive" onClick={openDialog} aria-label={`Fire ${username}`}>
        <UserMinus className="size-4" />
        Fire
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Fire {username}?</DialogTitle>
            <DialogDescription>
              They can&apos;t log in any more, their tracking link stops, and any Telegram account they hold goes back to the pool. What they
              earned this week is still paid.
            </DialogDescription>
          </DialogHeader>
          {!plan && !msg && <p className="text-sm text-muted-foreground">Checking who reports to them…</p>}
          {plan && under > 0 && (
            <div className="space-y-3 rounded-lg border p-3 text-sm">
              <p className="font-medium">
                {plural(under, ROLE[plan.under[0].role] ?? "person")} report to {plan.target.username}
                {plan.underTotal > under ? ` (${plan.underTotal} people in total)` : ""}. What should happen to them?
              </p>
              <label className="flex items-start gap-2">
                <input type="radio" name="reports" checked={choice === "move"} disabled={!plan.moveTargets.length} onChange={() => setChoice("move")} className="mt-1" />
                <span className="flex-1 space-y-1.5">
                  <span>Move them to another {ROLE[plan.target.role]}</span>
                  {plan.moveTargets.length ? (
                    <select className={select} value={moveTo} onChange={(e) => { setMoveTo(e.target.value); setChoice("move"); }} aria-label="Move them to">
                      <option value="">Choose…</option>
                      {plan.moveTargets.map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.username}
                          {m.model ? ` (${m.model})` : ""}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <span className="block text-xs text-muted-foreground">There&apos;s no other {ROLE[plan.target.role]} to move them to.</span>
                  )}
                  {plan.target.role === "LEAD_VA" && (
                    <span className="block text-xs text-muted-foreground">VAs moving to a team on another model get a Telegram account from that model&apos;s pool.</span>
                  )}
                </span>
              </label>
              <label className="flex items-start gap-2">
                <input type="radio" name="reports" checked={choice === "fire"} onChange={() => setChoice("fire")} className="mt-1" />
                <span>Fire them too</span>
              </label>
            </div>
          )}
          {msg && <p role="status" className={msg.ok ? "text-sm text-emerald-600" : "text-sm text-destructive"}>{msg.text}</p>}
          <DialogFooter>
            {msg?.ok ? (
              <Button onClick={() => setOpen(false)}>Done</Button>
            ) : (
              <Button variant="destructive" disabled={!canConfirm || pending} onClick={confirm}>
                {pending ? "Working…" : `Fire ${username}${under && choice === "fire" ? ` and ${plural(plan?.underTotal ?? under, "person", "people")}` : ""}`}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

// ── Move team / move all teams ───────────────────────────────────────────

function PlanSummary({ plan }: { plan: MovePlan }) {
  return (
    <div className="space-y-1 rounded-lg border p-3 text-sm">
      <p>
        <strong>{plural(plan.teams.length, "team")}</strong>, <strong>{plural(plan.vasMoving, "VA")}</strong> move
        {plan.from ? ` from ${plan.from.name}` : ""} to <strong>{plan.to.name}</strong>.
      </p>
      <p>
        {plan.to.name} has <strong>{plural(plan.available, "free account")}</strong>.
        {plan.alreadyWaiting > 0 && ` ${plural(plan.alreadyWaiting, "VA")} on ${plan.to.name} ${plan.alreadyWaiting === 1 ? "is" : "are"} already waiting for one.`}
      </p>
      {plan.short > 0 ? (
        <p className="font-medium text-destructive">
          {plural(plan.short, "account")} short: {plural(plan.short, "VA")} would be flagged &quot;Needs account&quot; until you add more to
          the {plan.to.name} pool. They get one automatically as soon as accounts are added.
        </p>
      ) : (
        <p className="text-emerald-600">Enough accounts for everyone.</p>
      )}
      <p className="text-xs text-muted-foreground">Each VA gets a Telegram message with their new account. Tracking links keep working; past earnings don&apos;t change.</p>
    </div>
  );
}

function MoveDialog({
  open,
  setOpen,
  title,
  models,
  excludeModelId,
  planFn,
  moveFn,
}: {
  open: boolean;
  setOpen: (o: boolean) => void;
  title: string;
  models: ModelOption[];
  excludeModelId: string | null;
  planFn: (to: string) => Promise<{ ok: true; data: MovePlan } | { ok: false; error: string }>;
  moveFn: (to: string, allowShort: boolean) => Promise<{ ok: true; data: { teams: number; vas: number; withAccount: number; needAccount: number } } | { ok: false; error: string }>;
}) {
  const [to, setTo] = useState("");
  const [plan, setPlan] = useState<MovePlan | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, start] = useTransition();
  const options = models.filter((m) => m.id !== excludeModelId);

  function preview(next: string) {
    setTo(next);
    setPlan(null);
    setMsg(null);
    if (!next) return;
    start(async () => {
      const r = await planFn(next);
      if (r.ok) setPlan(r.data);
      else setMsg({ ok: false, text: r.error });
    });
  }

  function confirm() {
    if (!plan) return;
    start(async () => {
      const r = await moveFn(to, plan.short > 0);
      if (!r.ok) return setMsg({ ok: false, text: r.error });
      const d = r.data;
      setMsg({ ok: true, text: `Moved ${plural(d.teams, "team")} and ${plural(d.vas, "VA")}${d.needAccount ? `; ${d.needAccount} need an account` : ""}.` });
    });
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) {
          setTo("");
          setPlan(null);
          setMsg(null);
        }
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>Pick the model to move to. You&apos;ll see what happens before anything changes.</DialogDescription>
        </DialogHeader>
        <div className="space-y-1.5">
          <Label htmlFor="move-to">Move to</Label>
          <select id="move-to" className={select} value={to} onChange={(e) => preview(e.target.value)} disabled={msg?.ok}>
            <option value="">Choose a model…</option>
            {options.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
          {options.length === 0 && <p className="text-xs text-muted-foreground">There&apos;s no other active model.</p>}
        </div>
        {pending && !plan && to && <p className="text-sm text-muted-foreground">Checking the pool…</p>}
        {plan && !msg?.ok && <PlanSummary plan={plan} />}
        {msg && <p role="status" className={msg.ok ? "text-sm text-emerald-600" : "text-sm text-destructive"}>{msg.text}</p>}
        <DialogFooter>
          {msg?.ok ? (
            <Button onClick={() => setOpen(false)}>Done</Button>
          ) : (
            <Button variant={plan?.short ? "destructive" : "default"} disabled={!plan || plan.vasMoving + plan.teams.length === 0 || pending} onClick={confirm}>
              {pending && plan ? "Moving…" : plan?.short ? `Move anyway (${plural(plan.short, "VA")} without an account)` : "Confirm move"}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function MoveTeamButton({ leadVaId, username, modelId, models }: { leadVaId: string; username: string; modelId: string | null; models: ModelOption[] }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button size="sm" variant="outline" onClick={() => setOpen(true)} aria-label={`Move ${username}'s team to another model`}>
        <ArrowRightLeft className="size-4" />
        Move team
      </Button>
      <MoveDialog
        open={open}
        setOpen={setOpen}
        title={`Move ${username}'s team to another model`}
        models={models}
        excludeModelId={modelId}
        planFn={(to) => planTeamMoveAction(leadVaId, to)}
        moveFn={(to, allowShort) => moveTeamAction(leadVaId, to, allowShort)}
      />
    </>
  );
}

export function MoveAllTeamsButton({ fromModel, models }: { fromModel: ModelOption; models: ModelOption[] }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
        <ArrowRightLeft className="size-4" />
        Move all teams
      </Button>
      <MoveDialog
        open={open}
        setOpen={setOpen}
        title={`Move all teams from ${fromModel.name}`}
        models={models}
        excludeModelId={fromModel.id}
        planFn={(to) => planBulkMoveAction(fromModel.id, to)}
        moveFn={(to, allowShort) => bulkMoveAction(fromModel.id, to, allowShort)}
      />
    </>
  );
}

// ── Fire inactive VAs ────────────────────────────────────────────────────

export function FireInactiveVas({ scope }: { scope: "all" | "team" }) {
  const [days, setDays] = useState(7);
  const [list, setList] = useState<InactiveVa[] | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [confirming, setConfirming] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, start] = useTransition();

  function find() {
    setMsg(null);
    setConfirming(false);
    start(async () => {
      const r = await findInactiveAction(days);
      if (!r.ok) return setMsg({ ok: false, text: r.error });
      setList(r.data);
      setPicked(new Set(r.data.map((v) => v.id)));
    });
  }

  function fire() {
    start(async () => {
      const r = await fireInactiveAction(days, [...picked]);
      setConfirming(false);
      if (!r.ok) return setMsg({ ok: false, text: r.error });
      setMsg({ ok: true, text: `Fired ${plural(r.data.fired, "VA")}.${r.data.skipped ? ` Skipped ${r.data.skipped} who qualified a convo in the meantime.` : ""}` });
      setList(null);
    });
  }

  const toggle = (id: string) =>
    setPicked((p) => {
      const n = new Set(p);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  return (
    <div className="space-y-3 text-sm">
      <div className="flex flex-wrap items-end gap-2">
        <div className="space-y-1.5">
          <Label htmlFor="inactive-days">No qualified convos in the last</Label>
          <select id="inactive-days" className={select} value={days} onChange={(e) => { setDays(Number(e.target.value)); setList(null); }}>
            {[3, 7, 14, 30].map((d) => (
              <option key={d} value={d}>
                {d} days
              </option>
            ))}
          </select>
        </div>
        <Button variant="outline" onClick={find} disabled={pending}>
          {pending && !list ? "Looking…" : `Find inactive VAs${scope === "team" ? " on my team" : ""}`}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">VAs hired within that period aren&apos;t included: they haven&apos;t had the chance yet.</p>
      {list && list.length === 0 && <p className="text-muted-foreground">Nobody matches. Every VA has qualified a convo in that time.</p>}
      {list && list.length > 0 && (
        <>
          <ul className="max-h-64 divide-y overflow-y-auto rounded-lg border">
            {list.map((v) => (
              <li key={v.id} className="flex items-center gap-3 px-3 py-2">
                <Checkbox id={`ina-${v.id}`} checked={picked.has(v.id)} onCheckedChange={() => toggle(v.id)} />
                <label htmlFor={`ina-${v.id}`} className="flex-1">
                  <span className="font-medium">{v.username}</span>
                  <span className="block text-xs text-muted-foreground">
                    {v.leadVa && scope === "all" ? `${v.leadVa}'s team · ` : ""}
                    {v.lastQualifiedAt ? `last qualified ${new Date(v.lastQualifiedAt).toLocaleDateString()}` : "never qualified a convo"}
                  </span>
                </label>
              </li>
            ))}
          </ul>
          {confirming ? (
            <div className="flex flex-wrap items-center gap-2 rounded-lg border border-destructive/40 p-3">
              <span>Fire {plural(picked.size, "VA")}? Their accounts go back to the pool.</span>
              <Button variant="destructive" size="sm" disabled={pending} onClick={fire}>
                {pending ? "Firing…" : `Yes, fire ${picked.size}`}
              </Button>
              <Button variant="ghost" size="sm" disabled={pending} onClick={() => setConfirming(false)}>
                Cancel
              </Button>
            </div>
          ) : (
            <Button variant="destructive" disabled={picked.size === 0} onClick={() => setConfirming(true)}>
              Fire {plural(picked.size, "selected VA")}…
            </Button>
          )}
        </>
      )}
      {msg && <p role="status" className={msg.ok ? "text-emerald-600" : "text-destructive"}>{msg.text}</p>}
    </div>
  );
}

// ── Rename model ─────────────────────────────────────────────────────────

export function RenameModel({ modelId, name }: { modelId: string; name: string }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(name);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  if (!editing) {
    return (
      <Button size="icon" variant="ghost" className="size-7" aria-label={`Rename ${name}`} onClick={() => { setValue(name); setError(null); setEditing(true); }}>
        <Pencil className="size-3.5" />
      </Button>
    );
  }
  return (
    <form
      className="flex flex-wrap items-center gap-1"
      onSubmit={(e) => {
        e.preventDefault();
        start(async () => {
          const r = await renameModelAction(modelId, value);
          if (!r.ok) return setError(r.error);
          setEditing(false);
        });
      }}
    >
      <Input value={value} onChange={(e) => setValue(e.target.value)} maxLength={40} className="h-8 w-40" aria-label="New model name" autoFocus />
      <Button size="sm" type="submit" disabled={pending || !value.trim()}>
        {pending ? "…" : "Save"}
      </Button>
      <Button size="sm" variant="ghost" type="button" onClick={() => setEditing(false)}>
        Cancel
      </Button>
      {error && <span className="w-full text-xs text-destructive">{error}</span>}
    </form>
  );
}
