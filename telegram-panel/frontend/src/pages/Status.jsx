import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, CheckCircle2, RefreshCw } from "lucide-react";
import { api } from "../api.js";
import { ago } from "../time.js";

function Stat({ label, value, tone }) {
  return (
    <div className="rounded-lg border bg-card px-3 py-2 text-center">
      <div className={`text-xl font-semibold ${tone ?? ""}`}>{value}</div>
      <div className="text-xs text-muted-foreground">{label}</div>
    </div>
  );
}

export default function Status() {
  const [status, setStatus] = useState(null);
  const [activity, setActivity] = useState([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const timer = useRef(null);

  const load = useCallback(async () => {
    try {
      const [s, a] = await Promise.all([api("/api/system/status"), api("/api/system/activity")]);
      setStatus(s);
      setActivity(a.activity);
      setError("");
    } catch (e) {
      setError(e.message);
    }
  }, []);

  useEffect(() => {
    load();
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

  return (
    <div className="space-y-4">
      <header className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Status</h1>
        <button type="button" aria-label="Refresh" onClick={load} className="rounded-lg p-2 hover:bg-secondary">
          <RefreshCw className="size-5" />
        </button>
      </header>

      {error && <p className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>}

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
