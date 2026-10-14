import { useState } from "react";
import { MoreVertical, Power, MessageCircle } from "lucide-react";
import { api } from "../api.js";
import { ago } from "../time.js";
import Toggle from "./Toggle.jsx";

const BORDER = { green: "border-l-emerald-500", amber: "border-l-amber-500", red: "border-l-red-500", grey: "border-l-muted-foreground/40" };

export default function AccountCard({ account, onChanged, onOpen }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const call = async (path, body) => {
    setBusy(true);
    setErr("");
    try {
      await api(path, { method: "POST", body });
      onChanged();
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };

  const name = account.username ? `@${account.username}` : account.tg_user_id;

  return (
    <div className={`rounded-xl border border-l-4 bg-card p-3 ${BORDER[account.color]}`}>
      <div className="flex items-center gap-3">
        {account.has_avatar ? (
          <img src={`/api/accounts/${account.id}/avatar`} alt="" className="size-11 shrink-0 rounded-full object-cover" />
        ) : (
          <div className="grid size-11 shrink-0 place-items-center rounded-full bg-secondary text-sm font-medium">
            {(account.username || "?")[0].toUpperCase()}
          </div>
        )}
        <button type="button" onClick={onOpen} className="min-w-0 flex-1 text-left">
          <div className="truncate font-medium">{name}</div>
          <div className="truncate text-sm text-muted-foreground">
            {account.phone || "no phone"} · {account.status_detail || account.status} · {ago(account.last_msg_at)}
          </div>
        </button>
        <button type="button" aria-label="Details" onClick={onOpen} className="rounded-lg p-2 hover:bg-secondary">
          <MoreVertical className="size-5" />
        </button>
      </div>

      <div className="mt-3 flex items-center justify-between gap-4 border-t pt-3">
        <label className="flex items-center gap-2 text-sm">
          <Power className="size-4 text-muted-foreground" />
          <span className="text-muted-foreground">Power</span>
          <Toggle on={account.power_on} disabled={busy} label="Power" onChange={(v) => call(`/api/accounts/${account.id}/power`, { on: v })} />
        </label>
        <label className="flex items-center gap-2 text-sm">
          <MessageCircle className="size-4 text-muted-foreground" />
          <span className="text-muted-foreground">AI</span>
          <Toggle
            on={account.ai_on}
            disabled={busy || !account.power_on}
            label="AI chat"
            onChange={(v) => call(`/api/accounts/${account.id}/ai`, { on: v })}
          />
        </label>
      </div>
      {err && <p className="mt-2 text-sm text-destructive">{err}</p>}
    </div>
  );
}
