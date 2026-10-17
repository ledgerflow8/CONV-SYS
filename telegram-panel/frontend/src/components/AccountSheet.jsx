import { useEffect, useState } from "react";
import { RotateCcw, Trash2 } from "lucide-react";
import { api } from "../api.js";
import { ago } from "../time.js";
import Dialog from "./Dialog.jsx";
import EditProfile from "./EditProfile.jsx";

const STATE_TONE = {
  active: "text-emerald-600",
  converted: "text-sky-600",
  stopped: "text-destructive",
  filtered: "text-amber-600",
};

export default function AccountSheet({ accountId, onClose, onChanged }) {
  const [acc, setAcc] = useState(null);
  const [catalog, setCatalog] = useState(null); // { configured, models, presets }
  const [stats, setStats] = useState(null);
  const [modelId, setModelId] = useState("");
  const [error, setError] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);

  const reload = () =>
    api(`/api/accounts/${accountId}`)
      .then((a) => {
        setAcc(a);
        setModelId((m) => m || (a.capital_model_id != null ? String(a.capital_model_id) : ""));
      })
      .catch((e) => setError(e.message));

  useEffect(() => {
    reload();
    api("/api/capital/catalog").then(setCatalog).catch(() => {});
    api(`/api/accounts/${accountId}/stats`).then(setStats).catch(() => {});
  }, [accountId]);

  // Auto-pick the only model, so the user just picks a preset.
  useEffect(() => {
    if (catalog?.models?.length === 1) setModelId((m) => m || String(catalog.models[0].id));
  }, [catalog]);

  const setPreset = async (presetId) => {
    setError("");
    try {
      if (!presetId) {
        await api(`/api/accounts/${accountId}`, { method: "PATCH", body: { profile_id: null } });
      } else {
        const preset = catalog?.presets?.find((p) => String(p.id) === String(presetId));
        await api(`/api/accounts/${accountId}/preset`, {
          method: "POST",
          body: { model_id: Number(modelId), preset_id: Number(presetId), name: preset?.name ?? null },
        });
      }
      await reload();
      onChanged();
    } catch (e) {
      setError(e.message);
    }
  };

  const resetChat = async (peer) => {
    setError("");
    try {
      await api(`/api/accounts/${accountId}/chats/${peer}/reset`, { method: "POST" });
      await reload();
    } catch (e) {
      setError(e.message);
    }
  };

  const del = async () => {
    setBusy(true);
    setError("");
    try {
      await api(`/api/accounts/${accountId}`, { method: "DELETE", body: { confirm } });
      onChanged();
      onClose();
    } catch (e) {
      setError(e.message);
      setBusy(false);
    }
  };

  const name = acc && (acc.username ? `@${acc.username}` : acc.tg_user_id);

  return (
    <Dialog title={acc ? name : "Account"} onClose={onClose}>
      {!acc && !error && <p className="text-sm text-muted-foreground">Loading…</p>}
      {error && <p className="text-sm text-destructive">{error}</p>}
      {acc && (
        <div className="max-h-[75vh] space-y-4 overflow-y-auto pr-1 text-sm">
          {!acc.has_username && (
            <p className="rounded-lg bg-amber-500/10 px-3 py-2 text-xs font-medium text-amber-700">
              No username — set one in Edit profile. Needed for the portal tracking link; until then it stays out of the pool.
            </p>
          )}

          <dl className="space-y-1">
            <Row k="Status" v={acc.status_detail || acc.status} />
            <Row k="Phone" v={acc.phone || "—"} />
            <Row k="Telegram ID" v={acc.tg_user_id} />
            <Row k="Connected" v={acc.connected ? "yes" : "no"} />
            <Row k="Last message" v={ago(acc.last_msg_at)} />
            <Row k="AI chat" v={acc.ai_on ? "on" : "off"} />
          </dl>

          {/* AI preset (replaces the old persona step) */}
          <div className="space-y-1">
            <span className="text-xs text-muted-foreground">AI preset</span>
            {catalog && !catalog.configured ? (
              <p className="text-xs text-muted-foreground">Set CAPITAL_LICENSE_KEY to list presets.</p>
            ) : (
              <>
                {catalog && catalog.models.length > 1 && (
                  <select
                    value={modelId}
                    onChange={(e) => setModelId(e.target.value)}
                    className="mb-2 h-10 w-full rounded-lg border bg-background px-3 outline-none focus:ring-2 focus:ring-ring"
                  >
                    <option value="">Pick a model…</option>
                    {catalog.models.map((m) => (
                      <option key={m.id} value={m.id}>{m.name}</option>
                    ))}
                  </select>
                )}
                <select
                  value={acc.capital_preset_id ?? ""}
                  disabled={!modelId}
                  onChange={(e) => setPreset(e.target.value)}
                  className="h-10 w-full rounded-lg border bg-background px-3 outline-none focus:ring-2 focus:ring-ring disabled:opacity-50"
                >
                  <option value="">No preset (AI off)</option>
                  {(catalog?.presets ?? []).map((p) => (
                    <option key={p.id} value={p.id}>{p.name}</option>
                  ))}
                </select>
                {!acc.profile_id && <span className="text-xs text-muted-foreground">Pick a preset to switch AI on.</span>}
              </>
            )}
          </div>

          {stats && <StatsBlock stats={stats} />}

          <div className="space-y-2">
            <h3 className="text-xs font-medium text-muted-foreground">Recent chats</h3>
            {acc.chats.length === 0 ? (
              <p className="text-sm text-muted-foreground">No chats yet.</p>
            ) : (
              <ul className="space-y-1.5">
                {acc.chats.map((c) => {
                  const resettable = c.ai_state !== "active" && !(c.ai_state === "stopped" && c.ai_state_reason === "underage");
                  return (
                    <li key={c.peer_id} className="flex items-center justify-between gap-2 rounded-lg border px-3 py-2">
                      <div className="min-w-0">
                        <div className="truncate">{c.peer_name || c.peer_username || c.peer_id}</div>
                        <div className={`text-xs ${STATE_TONE[c.ai_state] ?? "text-muted-foreground"}`}>
                          {c.ai_state}
                          {c.ai_state_reason ? ` · ${c.ai_state_reason}` : ""} · {ago(c.last_in_at)}
                        </div>
                      </div>
                      {resettable && (
                        <button
                          type="button"
                          onClick={() => resetChat(c.peer_id)}
                          aria-label="Reset chat"
                          className="inline-flex shrink-0 items-center gap-1 rounded-lg border px-2 py-1 text-xs hover:bg-secondary"
                        >
                          <RotateCcw className="size-3.5" /> Reset
                        </button>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          <div className="border-t pt-4">
            <EditProfile
              accountId={accountId}
              connected={acc.connected}
              currentUsername={acc.username}
              onSaved={async () => {
                await reload();
                onChanged();
              }}
            />
          </div>

          {!confirming ? (
            <button
              type="button"
              onClick={() => setConfirming(true)}
              className="flex w-full items-center justify-center gap-2 rounded-lg border border-destructive/40 px-3 py-2.5 font-medium text-destructive hover:bg-destructive/10"
            >
              <Trash2 className="size-4" /> Delete account
            </button>
          ) : (
            <div className="space-y-2 rounded-lg border border-destructive/40 p-3">
              <p className="text-destructive">
                This logs the account out of Telegram and removes it. Type <b>{acc.username || acc.tg_user_id}</b> to confirm.
              </p>
              <input
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                placeholder={acc.username || String(acc.tg_user_id)}
                className="h-10 w-full rounded-lg border bg-background px-3 outline-none focus:ring-2 focus:ring-ring"
              />
              <div className="flex gap-2">
                <button type="button" onClick={() => setConfirming(false)} className="h-10 flex-1 rounded-lg border font-medium">
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={del}
                  disabled={busy}
                  className="h-10 flex-1 rounded-lg bg-destructive font-medium text-white disabled:opacity-50"
                >
                  {busy ? "Deleting…" : "Delete"}
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </Dialog>
  );
}

function Row({ k, v }) {
  return (
    <div className="flex justify-between gap-4">
      <dt className="text-muted-foreground">{k}</dt>
      <dd className="truncate text-right">{v}</dd>
    </div>
  );
}

const PERIODS = [
  ["today", "Today"],
  ["week", "This week"],
  ["all", "All time"],
];
const METRICS = [
  ["new_chats", "New chats"],
  ["ai_replies", "AI replies"],
  ["convos_reported", "Convos reported"],
];

export function StatsBlock({ stats }) {
  return (
    <div className="space-y-2">
      <h3 className="text-xs font-medium text-muted-foreground">Stats</h3>
      <div className="overflow-hidden rounded-lg border">
        <table className="w-full text-xs">
          <thead>
            <tr className="bg-muted/50 text-muted-foreground">
              <th className="px-2 py-1.5 text-left font-medium"> </th>
              {PERIODS.map(([k, label]) => (
                <th key={k} className="px-2 py-1.5 text-right font-medium">{label}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {METRICS.map(([key, label]) => (
              <tr key={key} className="border-t">
                <td className="px-2 py-1.5 text-muted-foreground">{label}</td>
                {PERIODS.map(([p]) => (
                  <td key={p} className="px-2 py-1.5 text-right tabular-nums">{stats[p]?.[key] ?? 0}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
