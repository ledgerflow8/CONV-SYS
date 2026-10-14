import { useEffect, useState } from "react";
import { Trash2 } from "lucide-react";
import { api } from "../api.js";
import { ago } from "../time.js";
import Dialog from "./Dialog.jsx";

export default function AccountSheet({ accountId, onClose, onChanged }) {
  const [acc, setAcc] = useState(null);
  const [error, setError] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api(`/api/accounts/${accountId}`).then(setAcc).catch((e) => setError(e.message));
  }, [accountId]);

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
        <div className="space-y-4 text-sm">
          <dl className="space-y-1">
            <Row k="Status" v={acc.status_detail || acc.status} />
            <Row k="Phone" v={acc.phone || "—"} />
            <Row k="Telegram ID" v={acc.tg_user_id} />
            <Row k="Connected" v={acc.connected ? "yes" : "no"} />
            <Row k="Last message" v={ago(acc.last_msg_at)} />
            <Row k="AI chat" v={acc.ai_on ? "on" : "off"} />
          </dl>
          <p className="text-xs text-muted-foreground">Personas and chats arrive in step 3.</p>

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
