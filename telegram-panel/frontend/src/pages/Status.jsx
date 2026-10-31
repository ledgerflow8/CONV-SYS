import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, CheckCircle2, HardDrive, RefreshCw } from "lucide-react";
import { api } from "../api.js";
import { ago } from "../time.js";
import Toggle from "../components/Toggle.jsx";
import { StatsBlock } from "../components/AccountSheet.jsx";

function Stat({ label, value, tone }) {
  return (
    <div className="rounded-lg border bg-card px-3 py-2 text-center">
      <div className={`text-xl font-semibold ${tone ?? ""}`}>{value}</div>
      <div className="text-xs text-muted-foreground">{label}</div>
    </div>
  );
}

function NumberSetting({ label, value, onSave }) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  const commit = () => {
    const n = Number(v);
    if (Number.isFinite(n) && n !== value) onSave(n);
    else setV(value);
  };
  return (
    <label className="flex items-center justify-between gap-4 text-sm">
      <span>{label}</span>
      <input
        type="number"
        value={v}
        onChange={(e) => setV(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
        className="h-9 w-24 rounded-lg border bg-background px-3 text-right outline-none focus:ring-2 focus:ring-ring"
      />
    </label>
  );
}

const mb = (n) => `${(n / (1024 * 1024)).toLocaleString("en-US", { maximumFractionDigits: n < 10 * 1024 * 1024 ? 1 : 0 })} MB`;

function DiskCard({ disk, onCompacted }) {
  const [state, setState] = useState({ busy: false, confirm: false, msg: "", err: "" });
  const tone = disk.level === "critical" ? "bg-red-500" : disk.level === "warn" ? "bg-amber-500" : "bg-emerald-500";
  const compact = async () => {
    setState({ busy: true, confirm: false, msg: "", err: "" });
    try {
      const r = await api("/api/system/db/compact", { method: "POST" });
      setState({ busy: false, confirm: false, err: "", msg: `Database compacted: ${mb(r.before_bytes)} → ${mb(r.after_bytes)}.` });
      onCompacted();
    } catch (e) {
      setState({ busy: false, confirm: false, msg: "", err: e.message });
    }
  };
  const b = disk.breakdown;
  return (
    <section className="space-y-3 rounded-xl border bg-card p-4">
      <div className="flex items-center justify-between">
        <h2 className="inline-flex items-center gap-2 font-medium">
          <HardDrive className="size-4" /> Data disk
        </h2>
        <span className="text-sm tabular-nums">{disk.used_pct}% used</span>
      </div>
      {disk.level !== "ok" && (
        <p className="flex gap-2 rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" />
          {disk.level === "critical" ? "Disk almost full: new messages may fail to save." : "Disk over 80% full."} Grow the disk on Render
          (Settings → Disks).
        </p>
      )}
      <div className="h-2 overflow-hidden rounded-full bg-secondary">
        <div className={`h-full ${tone}`} style={{ width: `${Math.min(100, disk.used_pct)}%` }} />
      </div>
      <p className="text-sm text-muted-foreground">
        {mb(disk.free_bytes)} free of {mb(disk.total_bytes)} · database {mb(b.database + b.database_wal)} · media {mb(b.ai_media)} · avatars{" "}
        {mb(b.avatars)}
      </p>
      <p className="text-xs text-muted-foreground">
        Cleanup runs hourly{disk.housekeeping.last_run_at ? `, last ${ago(disk.housekeeping.last_run_at)}` : ""}: old messages (kept: 30 days and
        each chat&apos;s latest 50), delivered portal events after 7 days, activity after 30 days, leftover media.
        {disk.housekeeping.last_error && <span className="text-destructive"> Last cleanup failed: {disk.housekeeping.last_error}</span>}
      </p>
      {disk.housekeeping.last_checkpoint?.failures_in_a_row > 0 && (
        <p className="flex gap-2 rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" />
          The database log couldn&apos;t be folded in ({disk.housekeeping.last_checkpoint.failures_in_a_row} hourly attempt
          {disk.housekeeping.last_checkpoint.failures_in_a_row > 1 ? "s" : ""} in a row, now {mb(disk.housekeeping.last_checkpoint.wal_bytes)}). If it
          keeps growing, the disk fills again. See Recent activity.
        </p>
      )}
      {state.confirm ? (
        <div className="space-y-2 rounded-lg border p-3 text-sm">
          <p>Compacting rewrites the database to give freed space back to the disk. New messages wait while it runs (seconds to a minute). Do it at a quiet time.</p>
          <div className="flex gap-2">
            <button type="button" onClick={compact} className="h-8 rounded-lg bg-primary px-3 font-medium text-primary-foreground">
              Compact now
            </button>
            <button type="button" onClick={() => setState((s) => ({ ...s, confirm: false }))} className="h-8 rounded-lg border px-3">
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          disabled={state.busy}
          onClick={() => setState((s) => ({ ...s, confirm: true, msg: "", err: "" }))}
          className="h-8 rounded-lg border px-3 text-sm disabled:opacity-50"
        >
          {state.busy ? "Compacting…" : "Compact database"}
        </button>
      )}
      {state.msg && <p className="text-sm text-emerald-600">{state.msg}</p>}
      {state.err && <p className="text-sm text-destructive">{state.err}</p>}
    </section>
  );
}

function defaultSince() {
  // Today 15:30 UTC: just before the 2026-10-25 disk-full outage began (~16:00 UTC).
  return `${new Date().toISOString().slice(0, 10)}T15:30`;
}

function RecoveryCard() {
  const [since, setSince] = useState(defaultSince);
  const [job, setJob] = useState(null);
  const [confirm, setConfirm] = useState(false);
  const [err, setErr] = useState("");
  const poll = useRef(null);

  const follow = useCallback(() => {
    clearInterval(poll.current);
    poll.current = setInterval(async () => {
      try {
        const r = await api("/api/system/recover");
        setJob(r.recovery);
        if (!r.recovery?.running) clearInterval(poll.current);
      } catch (e) {
        setErr(e.message);
        clearInterval(poll.current);
      }
    }, 2000);
  }, []);

  useEffect(() => {
    api("/api/system/recover")
      .then((r) => {
        setJob(r.recovery);
        if (r.recovery?.running) follow();
      })
      .catch(() => {});
    return () => clearInterval(poll.current);
  }, [follow]);

  const start = async (dryRun) => {
    setErr("");
    setConfirm(false);
    try {
      const r = await api("/api/system/recover", { method: "POST", body: { since: `${since}:00Z`, dry_run: dryRun } });
      setJob(r.recovery);
      follow();
    } catch (e) {
      setErr(e.message);
    }
  };

  const t = job?.totals;
  return (
    <section className="space-y-3 rounded-xl border bg-card p-4">
      <h2 className="font-medium">Recover missed convos</h2>
      <p className="text-sm text-muted-foreground">
        Re-reads each connected account&apos;s chats since the time below and sends the portal any new convos or replies that failed to
        save. Safe to repeat: nothing is sent twice. No messages are sent to fans.
      </p>
      <label className="flex items-center justify-between gap-3 text-sm">
        <span>Since (UTC)</span>
        <input
          type="datetime-local"
          value={since}
          onChange={(e) => setSince(e.target.value)}
          className="h-9 rounded-lg border bg-background px-2 outline-none focus:ring-2 focus:ring-ring"
        />
      </label>
      {confirm ? (
        <div className="space-y-2 rounded-lg border p-3 text-sm">
          <p>Queue the missing events for the portal?</p>
          <div className="flex gap-2">
            <button type="button" onClick={() => start(false)} className="h-8 rounded-lg bg-primary px-3 font-medium text-primary-foreground">
              Recover
            </button>
            <button type="button" onClick={() => setConfirm(false)} className="h-8 rounded-lg border px-3">
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <div className="flex gap-2">
          <button type="button" disabled={job?.running} onClick={() => start(true)} className="h-8 rounded-lg border px-3 text-sm disabled:opacity-50">
            Preview
          </button>
          <button
            type="button"
            disabled={job?.running}
            onClick={() => setConfirm(true)}
            className="h-8 rounded-lg bg-primary px-3 text-sm font-medium text-primary-foreground disabled:opacity-50"
          >
            Recover
          </button>
        </div>
      )}
      {err && <p className="text-sm text-destructive">{err}</p>}
      {job && (
        <div className="space-y-1 rounded-lg bg-secondary/60 p-3 text-sm">
          <p className="font-medium">
            {job.running ? "Running" : job.dry_run ? "Preview" : "Done"} · {job.accounts_done}/{job.accounts_total} accounts
          </p>
          <p>
            {t.chats_scanned} chats checked · {t.messages_restored} messages {job.dry_run ? "to restore" : "restored"}
          </p>
          <p>
            Missing events {job.dry_run ? "found" : "queued"}: <strong>{t.first_events}</strong> new convos, <strong>{t.reply_events}</strong>{" "}
            replies
          </p>
          <p className="text-muted-foreground">{t.unanswered} chats end with a fan message (no reply yet).</p>
          {job.accounts
            .filter((a) => a.error)
            .map((a) => (
              <p key={a.account_id} className="text-destructive">
                @{a.username ?? a.account_id}: {a.error}
              </p>
            ))}
          {job.error && <p className="text-destructive">{job.error}</p>}
        </div>
      )}
    </section>
  );
}

export default function Status() {
  const [status, setStatus] = useState(null);
  const [activity, setActivity] = useState([]);
  const [settings, setSettings] = useState(null);
  const [stats, setStats] = useState(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const timer = useRef(null);

  const load = useCallback(async () => {
    try {
      const [s, a, cfg] = await Promise.all([
        api("/api/system/status"),
        api("/api/system/activity"),
        api("/api/system/settings"),
      ]);
      setStatus(s);
      setActivity(a.activity);
      setSettings(cfg.settings);
      setError("");
    } catch (e) {
      setError(e.message);
    }
  }, []);

  const saveSetting = async (patch) => {
    setSettings((s) => ({ ...s, ...patch }));
    try {
      const r = await api("/api/system/settings", { method: "PATCH", body: patch });
      setSettings(r.settings);
      await load();
    } catch (e) {
      setError(e.message);
      await load();
    }
  };

  useEffect(() => {
    load();
    // Stats hit Capitalbot, so fetch once (not on the 10s poll).
    api("/api/system/stats").then(setStats).catch(() => {});
  }, [load]);

  useEffect(() => {
    const tick = () => document.visibilityState === "visible" && load();
    timer.current = setInterval(tick, 10000);
    return () => clearInterval(timer.current);
  }, [load]);

  const retry = async () => {
    setBusy(true);
    try {
      await api("/api/system/outbox/retry-failed", { method: "POST" });
      await load();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const p = status?.portal;
  const ai = status?.ai;

  return (
    <div className="space-y-4">
      <header className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Status</h1>
        <button type="button" aria-label="Refresh" onClick={load} className="rounded-lg p-2 hover:bg-secondary">
          <RefreshCw className="size-5" />
        </button>
      </header>

      {error && <p className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>}

      {status?.disk && <DiskCard disk={status.disk} onCompacted={load} />}

      {stats && (
        <section className="space-y-3 rounded-xl border bg-card p-4">
          <h2 className="font-medium">Stats (all accounts)</h2>
          {stats.portal_week?.counts && (
            <div className="space-y-1">
              <p className="text-xs text-muted-foreground">This week, from the portal (matches the VA dashboard)</p>
              <div className="grid grid-cols-3 gap-2">
                <Stat label="Qualified" value={stats.portal_week.counts.qualified ?? 0} tone="text-emerald-600" />
                <Stat label="Pending" value={stats.portal_week.counts.pending ?? 0} tone="text-amber-600" />
                <Stat label="Rejected" value={stats.portal_week.counts.rejected ?? 0} tone="text-destructive" />
              </div>
            </div>
          )}
          <StatsBlock stats={stats.panel} />
          {stats.capital && stats.capital.week && (
            <div className="grid grid-cols-3 gap-2">
              <Stat label="Capitalbot msgs (7d)" value={stats.capital.week.messages ?? "—"} />
              <Stat label="New convos (7d)" value={stats.capital.week.newConversations ?? "—"} />
              <Stat label="Conversions (7d)" value={stats.capital.week.conversionsTotal ?? "—"} />
            </div>
          )}
        </section>
      )}

      <section className="space-y-3 rounded-xl border bg-card p-4">
        <div className="flex items-center justify-between">
          <h2 className="font-medium">Portal sync</h2>
          {p &&
            (p.configured ? (
              <span className="inline-flex items-center gap-1 text-xs text-emerald-600">
                <CheckCircle2 className="size-4" /> Connected
              </span>
            ) : (
              <span className="inline-flex items-center gap-1 text-xs text-amber-600">
                <AlertTriangle className="size-4" /> Not configured
              </span>
            ))}
        </div>

        {p && (
          <>
            <div className="grid grid-cols-3 gap-2">
              <Stat label="Queued" value={p.pending} />
              <Stat label="Sent" value={p.sent} tone="text-emerald-600" />
              <Stat label="Failed" value={p.failed} tone={p.failed ? "text-destructive" : undefined} />
            </div>
            <p className="text-sm text-muted-foreground">
              {p.last_ok_at ? `Last delivered ${ago(p.last_ok_at)}.` : "Nothing delivered yet."}
            </p>
            {p.last_error && <p className="text-sm text-amber-600">{p.last_error}</p>}

            {p.failed_rows.length > 0 && (
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium text-destructive">Rejected by the portal</span>
                  <button
                    type="button"
                    onClick={retry}
                    disabled={busy}
                    className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-primary px-3 text-sm font-medium text-primary-foreground disabled:opacity-50"
                  >
                    <RefreshCw className={`size-4 ${busy ? "animate-spin" : ""}`} /> Retry failed
                  </button>
                </div>
                <ul className="space-y-1.5">
                  {p.failed_rows.map((r) => (
                    <li key={r.id} className="rounded-lg bg-destructive/5 px-3 py-2 text-sm">
                      <div className="font-medium">
                        {r.kind} · {r.payload.tgAccount}
                        {r.payload.peerId ? ` → ${r.payload.peerId}` : ""}
                      </div>
                      <div className="text-destructive">{r.error}</div>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </>
        )}
      </section>

      <section className="space-y-3 rounded-xl border bg-card p-4">
        <div className="flex items-center justify-between">
          <h2 className="font-medium">Capitalbot AI</h2>
          {ai &&
            (ai.configured ? (
              <span className="inline-flex items-center gap-1 text-xs text-emerald-600">
                <CheckCircle2 className="size-4" /> Connected
              </span>
            ) : (
              <span className="inline-flex items-center gap-1 text-xs text-amber-600">
                <AlertTriangle className="size-4" /> No license key
              </span>
            ))}
        </div>
        {ai && (
          <>
            <label className="flex items-center justify-between gap-4">
              <span className="text-sm">
                <span className="font-medium">AI replies</span>
                <span className="block text-xs text-muted-foreground">Master kill switch for every account.</span>
              </span>
              <Toggle on={!!ai.global_on} label="AI replies" onChange={(v) => saveSetting({ ai_global_on: v })} />
            </label>
            {ai.credit_over_until && (
              <p className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">
                AI credits depleted — replies paused until {ago(ai.credit_over_until)} from now.
              </p>
            )}
            {ai.last_error && <p className="text-sm text-amber-600">Last AI error: {ai.last_error}</p>}
          </>
        )}
      </section>

      <RecoveryCard />

      {settings && (
        <section className="space-y-3 rounded-xl border bg-card p-4">
          <h2 className="font-medium">Settings</h2>
          <NumberSetting label="Quiet after (hours)" value={settings.quiet_after_hours} onSave={(v) => saveSetting({ quiet_after_hours: v })} />
          <NumberSetting label="Reply delay (seconds)" value={settings.ai_debounce_sec} onSave={(v) => saveSetting({ ai_debounce_sec: v })} />
          <NumberSetting label="Typing speed (chars/sec)" value={settings.typing_cps} onSave={(v) => saveSetting({ typing_cps: v })} />
        </section>
      )}

      <BulkActions />
      <TierSettings />
      <Backup />

      <section className="space-y-2 rounded-xl border bg-card p-4">
        <h2 className="font-medium">Recent activity</h2>
        {activity.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nothing yet.</p>
        ) : (
          <ul className="space-y-1.5">
            {activity.map((a) => (
              <li key={a.id} className="flex items-start gap-2 text-sm">
                <span
                  className={`mt-1.5 size-2 shrink-0 rounded-full ${
                    a.level === "error" ? "bg-red-500" : a.level === "warn" ? "bg-amber-500" : "bg-muted-foreground/40"
                  }`}
                />
                <span className="flex-1">{a.message}</span>
                <span className="shrink-0 text-xs text-muted-foreground">{ago(a.at)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

const ONLINE_PRIVACY = { last_seen: "everybody", profile_photo: "everybody" };

function BulkActions() {
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState("");
  const [result, setResult] = useState(null); // { kind, results }
  const [confirming, setConfirming] = useState(false);

  const call = async (kind, ids) => {
    setBusy(kind); setErr("");
    try {
      const body = kind === "priv"
        ? (ids ? { account_ids: ids, rules: ONLINE_PRIVACY } : { all: true, rules: ONLINE_PRIVACY })
        : (ids ? { account_ids: ids } : { all: true });
      const path = kind === "priv" ? "/api/accounts/bulk/privacy" : "/api/accounts/bulk/clean-profile";
      const r = await api(path, { method: "POST", body });
      setResult({ kind, results: r.results });
      setConfirming(false);
    } catch (e) { setErr(e.message); } finally { setBusy(""); }
  };

  const failed = result ? result.results.filter((r) => !r.ok) : [];
  const okCount = result ? result.results.length - failed.length : 0;
  const label = result?.kind === "priv" ? "Privacy (online defaults)" : "Clean profiles";

  return (
    <section className="space-y-3 rounded-xl border bg-card p-4">
      <h2 className="font-medium">Bulk account actions</h2>
      <button type="button" onClick={() => call("priv")} disabled={!!busy} className="h-10 w-full rounded-lg border font-medium disabled:opacity-50">
        {busy === "priv" ? "Applying…" : "Apply online privacy to all accounts"}
      </button>
      {!confirming ? (
        <button type="button" onClick={() => setConfirming(true)} disabled={!!busy} className="h-10 w-full rounded-lg border border-destructive/40 font-medium text-destructive hover:bg-destructive/10 disabled:opacity-50">
          Clean all profiles (stories &amp; songs)
        </button>
      ) : (
        <div className="space-y-2 rounded-lg border border-destructive/40 p-3">
          <p className="text-sm">Permanently delete every story and profile song on <b>all connected accounts</b>?</p>
          <div className="flex gap-2">
            <button type="button" onClick={() => setConfirming(false)} className="h-10 flex-1 rounded-lg border font-medium">Cancel</button>
            <button type="button" onClick={() => call("clean")} disabled={busy === "clean"} className="h-10 flex-1 rounded-lg bg-destructive font-medium text-white disabled:opacity-50">
              {busy === "clean" ? "Cleaning…" : "Clean all"}
            </button>
          </div>
        </div>
      )}

      {result && (
        <div className="space-y-2 rounded-lg border bg-muted/30 p-3">
          <p className="text-sm font-medium">
            {label}: {okCount} of {result.results.length} done
            {failed.length > 0 && <span className="text-destructive"> · {failed.length} failed</span>}
          </p>
          {failed.length > 0 && (
            <>
              <ul className="max-h-48 space-y-1 overflow-auto text-sm">
                {failed.map((r) => (
                  <li key={r.account_id} className="flex justify-between gap-3">
                    <span className="shrink-0 font-medium">@{r.username ?? r.account_id}</span>
                    <span className="truncate text-right text-destructive" title={r.error}>{r.error}</span>
                  </li>
                ))}
              </ul>
              <button
                type="button"
                onClick={() => call(result.kind, failed.map((r) => r.account_id))}
                disabled={!!busy}
                className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-primary px-3 text-sm font-medium text-primary-foreground disabled:opacity-50"
              >
                <RefreshCw className={`size-4 ${busy ? "animate-spin" : ""}`} /> Retry failed ({failed.length})
              </button>
            </>
          )}
        </div>
      )}
      {err && <p className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">{err}</p>}
    </section>
  );
}

function TierSettings() {
  const [t, setT] = useState(null);
  const [enabled, setEnabled] = useState(false); // feature flag (PHONE_FILTER_ENABLED)
  const [err, setErr] = useState("");
  const refresh = () =>
    api("/api/system/tier").then((r) => { setT(r.tier); setEnabled(r.feature_enabled); }).catch((e) => setErr(e.message));
  useEffect(() => { refresh(); }, []);
  const save = async (patch) => {
    setT((p) => ({ ...p, ...patch }));
    try {
      const r = await api("/api/system/tier", { method: "PATCH", body: patch });
      setT(r.tier);
      setErr("");
    } catch (e) {
      setErr(e.message);
      refresh();
    }
  };
  if (!enabled || !t) return null; // hidden entirely until the feature flag is on
  return (
    <section className="space-y-3 rounded-xl border bg-card p-4">
      <h2 className="font-medium">Tier-1 filter</h2>
      <label className="flex items-center justify-between gap-4">
        <span className="text-sm">
          <span className="font-medium">Only reply to Tier 1 numbers</span>
          <span className="block text-xs text-muted-foreground">Skip Capitalbot for a visible non-Tier-1 phone (saves credits).</span>
        </span>
        <Toggle on={!!t.only} label="Tier 1 only" onChange={(v) => save({ only: v })} />
      </label>
      <label className="flex items-center justify-between gap-4 text-sm">
        <span>Hidden phone</span>
        <select
          value={t.hidden}
          onChange={(e) => save({ hidden: e.target.value })}
          className="h-9 rounded-lg border bg-background px-2 text-sm outline-none focus:ring-2 focus:ring-ring"
        >
          <option value="ai">Let Capitalbot decide</option>
          <option value="skip">Don't reply</option>
        </select>
      </label>
      <label className="block text-sm">
        Tier 1 countries (ISO-2)
        <input
          defaultValue={t.countries.join(", ")}
          onBlur={(e) => save({ countries: e.target.value.split(/[,\s]+/).filter(Boolean) })}
          className="mt-1 h-9 w-full rounded-lg border bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-ring"
        />
      </label>
      {err && <p className="text-sm text-destructive">{err}</p>}
    </section>
  );
}

function Backup() {
  const [pw, setPw] = useState("");
  const [imp, setImp] = useState({ pw: "", file: null });
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState("");

  const exportNow = async () => {
    if (pw.length < 8) { setErr("Use a backup password of at least 8 characters."); return; }
    setErr(""); setMsg(""); setBusy("exp");
    try {
      const res = await fetch("/api/system/backup/export", {
        method: "POST", credentials: "same-origin",
        headers: { "Content-Type": "application/json", "X-Panel": "1" }, body: JSON.stringify({ password: pw }),
      });
      if (!res.ok) throw new Error(`Export failed (${res.status})`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = res.headers.get("Content-Disposition")?.match(/filename="(.+?)"/)?.[1] || "panel-backup.tgpbak";
      document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
      setMsg("Backup downloaded. Store it and the password somewhere safe."); setPw("");
    } catch (e) { setErr(e.message); } finally { setBusy(""); }
  };

  const restore = async () => {
    if (!imp.file || !imp.pw) return;
    setErr(""); setMsg(""); setBusy("imp");
    try {
      const fd = new FormData();
      fd.append("password", imp.pw);
      fd.append("file", imp.file);
      const res = await fetch("/api/system/backup/import", { method: "POST", credentials: "same-origin", headers: { "X-Panel": "1" }, body: fd });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.detail || `Restore failed (${res.status})`);
      setMsg(`Restored ${data.restored}, skipped ${data.skipped} of ${data.total}. Power them on to connect.`);
      setImp({ pw: "", file: null });
    } catch (e) { setErr(e.message); } finally { setBusy(""); }
  };

  return (
    <section className="space-y-3 rounded-xl border bg-card p-4">
      <h2 className="font-medium">Backup</h2>
      <p className="text-xs text-muted-foreground">An encrypted archive of every account (sessions + 2FA). The password can't be recovered — keep it safe.</p>
      <div className="flex gap-2">
        <input
          type="password" value={pw} onChange={(e) => setPw(e.target.value)} placeholder="Backup password (min 8)"
          className="h-10 flex-1 rounded-lg border bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-ring"
        />
        <button type="button" onClick={exportNow} disabled={busy === "exp"} className="h-10 shrink-0 rounded-lg bg-primary px-3 text-sm font-medium text-primary-foreground disabled:opacity-50">
          {busy === "exp" ? "Exporting…" : "Export backup"}
        </button>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <input type="file" accept=".tgpbak" onChange={(e) => setImp((s) => ({ ...s, file: e.target.files?.[0] ?? null }))} className="min-w-0 flex-1 text-sm" />
        <input
          type="password" value={imp.pw} onChange={(e) => setImp((s) => ({ ...s, pw: e.target.value }))} placeholder="Backup password"
          className="h-10 rounded-lg border bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-ring"
        />
        <button type="button" onClick={restore} disabled={!imp.file || !imp.pw || busy === "imp"} className="h-10 shrink-0 rounded-lg border px-3 text-sm font-medium disabled:opacity-50">
          {busy === "imp" ? "Restoring…" : "Restore"}
        </button>
      </div>
      {msg && <p className="rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-700">{msg}</p>}
      {err && <p className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">{err}</p>}
    </section>
  );
}
