import { useCallback, useEffect, useState } from "react";
import { ArrowLeft, Bot, RefreshCw, User } from "lucide-react";
import { api } from "../api.js";

// Chat logs: every chat with its AI outcome; open one to read its last 50 messages live from
// Telegram next to the AI log (what the fan said, each Capitalbot call, each reply delivered).

const FIELD = "h-10 w-full rounded-lg border bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-ring";
const PAGE = 50;

const STATUS_LABEL = {
  ok: "OK",
  credit_over: "Credits empty",
  tier_filtered: "Tier filtered",
  error: "Error",
  ai_off: "AI off",
  kill_switch: "Kill switch",
};
const STATUS_TONE = {
  ok: "bg-emerald-100 text-emerald-800",
  credit_over: "bg-red-100 text-red-800",
  tier_filtered: "bg-amber-100 text-amber-800",
  error: "bg-red-100 text-red-800",
  ai_off: "bg-secondary text-muted-foreground",
  kill_switch: "bg-red-100 text-red-800",
};
const KIND_LABEL = {
  fan_msg: "Fan wrote",
  ai_request: "Asked Capitalbot",
  ai_reply_sent: "AI reply delivered",
  ai_skipped: "No AI reply sent",
};

function when(iso) {
  if (!iso) return "—";
  return new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function StatusChip({ status }) {
  if (!status) return null;
  return <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_TONE[status] ?? ""}`}>{STATUS_LABEL[status] ?? status}</span>;
}

function RepliedChip({ yes }) {
  return yes ? (
    <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-800">AI replied</span>
  ) : (
    <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800">No AI reply</span>
  );
}

function fanName(c) {
  return c.peer_name || (c.peer_username ? `@${c.peer_username}` : `Fan ${c.peer_id}`);
}

export default function Chats() {
  const [filters, setFilters] = useState({ account_id: "", ai_replied: "", capital_status: "", date_from: "", date_to: "" });
  const [data, setData] = useState(null);
  const [rows, setRows] = useState([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(null); // {account_id, peer_id}

  const query = new URLSearchParams(Object.entries(filters).filter(([, v]) => v)).toString();

  const load = useCallback(
    async (offset = 0) => {
      setLoading(true);
      try {
        const d = await api(`/api/chats?${query}${query ? "&" : ""}offset=${offset}&limit=${PAGE}`);
        setData(d);
        setRows((r) => (offset ? [...r, ...d.chats] : d.chats));
        setError("");
      } catch (e) {
        setError(e.message);
      } finally {
        setLoading(false);
      }
    },
    [query],
  );

  useEffect(() => {
    load(0);
  }, [load]);

  const set = (patch) => setFilters((f) => ({ ...f, ...patch }));

  if (open) return <ChatDetail which={open} onBack={() => setOpen(null)} />;

  const total = data?.total ?? 0;
  return (
    <div className="space-y-4">
      <header className="flex items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">Chat logs</h1>
        <button type="button" aria-label="Refresh" onClick={() => load(0)} className="rounded-lg p-2 hover:bg-secondary">
          <RefreshCw className="size-5" />
        </button>
      </header>

      {error && <p className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>}

      <section className="grid grid-cols-2 gap-2 rounded-xl border bg-card p-3">
        <select value={filters.account_id} onChange={(e) => set({ account_id: e.target.value })} className={`${FIELD} col-span-2`} aria-label="Account">
          <option value="">All accounts</option>
          {(data?.accounts ?? []).map((a) => (
            <option key={a.id} value={a.id}>
              @{a.username ?? a.id}
            </option>
          ))}
        </select>
        <select value={filters.ai_replied} onChange={(e) => set({ ai_replied: e.target.value })} className={FIELD} aria-label="AI replied">
          <option value="">AI replied: any</option>
          <option value="yes">AI replied</option>
          <option value="no">No AI reply</option>
        </select>
        <select value={filters.capital_status} onChange={(e) => set({ capital_status: e.target.value })} className={FIELD} aria-label="AI status">
          <option value="">Any AI status</option>
          {(data?.statuses ?? []).map((s) => (
            <option key={s} value={s}>
              Had: {STATUS_LABEL[s] ?? s}
            </option>
          ))}
        </select>
        <label className="text-xs text-muted-foreground">
          First message from
          <input type="date" value={filters.date_from} onChange={(e) => set({ date_from: e.target.value })} className={`${FIELD} mt-1`} />
        </label>
        <label className="text-xs text-muted-foreground">
          To
          <input type="date" value={filters.date_to} onChange={(e) => set({ date_to: e.target.value })} className={`${FIELD} mt-1`} />
        </label>
      </section>

      <p className="text-sm text-muted-foreground">{loading && !rows.length ? "Loading…" : `${total} chat${total === 1 ? "" : "s"} (dates in UTC)`}</p>

      <ul className="space-y-2">
        {rows.map((c) => (
          <li key={`${c.account_id}:${c.peer_id}`}>
            <button
              type="button"
              onClick={() => setOpen({ account_id: c.account_id, peer_id: c.peer_id })}
              className="w-full space-y-1.5 rounded-xl border bg-card p-3 text-left hover:bg-secondary/40"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="truncate font-medium">{fanName(c)}</span>
                <span className="shrink-0 text-xs text-muted-foreground">{when(c.last_at)}</span>
              </div>
              <div className="text-xs text-muted-foreground">
                @{c.account ?? c.account_id} · first message {when(c.first_in_at)}
                {c.reported_replied_at ? ` · reported replied ${when(c.reported_replied_at)}` : ""}
              </div>
              <div className="flex flex-wrap gap-1.5">
                <RepliedChip yes={c.ai_replied} />
                <StatusChip status={c.last_status} />
                {c.ai_state !== "active" && (
                  <span className="rounded-full bg-secondary px-2 py-0.5 text-xs text-muted-foreground">
                    {c.ai_state}
                    {c.ai_state_reason ? ` (${c.ai_state_reason})` : ""}
                  </span>
                )}
              </div>
            </button>
          </li>
        ))}
      </ul>

      {rows.length < total && (
        <button
          type="button"
          disabled={loading}
          onClick={() => load(rows.length)}
          className="h-10 w-full rounded-lg border bg-card text-sm font-medium disabled:opacity-50"
        >
          {loading ? "Loading…" : "Load more"}
        </button>
      )}
    </div>
  );
}

function ChatDetail({ which, onBack }) {
  const [d, setD] = useState(null);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      setD(await api(`/api/chats/${which.account_id}/${encodeURIComponent(which.peer_id)}`));
      setError("");
    } catch (e) {
      setError(e.message);
    }
  }, [which]);

  useEffect(() => {
    load();
  }, [load]);

  const c = d?.chat;
  return (
    <div className="space-y-4">
      <header className="flex items-center gap-2">
        <button type="button" aria-label="Back to chat logs" onClick={onBack} className="rounded-lg p-2 hover:bg-secondary">
          <ArrowLeft className="size-5" />
        </button>
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-xl font-semibold">{c ? fanName(c) : "Chat"}</h1>
          {c && (
            <p className="truncate text-xs text-muted-foreground">
              @{c.account} · fan id {c.peer_id}
              {c.peer_username ? ` · @${c.peer_username}` : ""}
            </p>
          )}
        </div>
        <button type="button" aria-label="Refresh" onClick={load} className="rounded-lg p-2 hover:bg-secondary">
          <RefreshCw className="size-5" />
        </button>
      </header>

      {error && <p className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>}
      {!d && !error && <p className="text-sm text-muted-foreground">Loading…</p>}

      {c && (
        <section className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
          <RepliedChip yes={c.ai_replied} />
          <span>First message {when(c.first_in_at)}</span>
          <span>· {c.reported_replied_at ? `reported replied ${when(c.reported_replied_at)}` : "not reported as replied"}</span>
        </section>
      )}

      {d && (
        <section className="space-y-2 rounded-xl border bg-card p-3">
          <h2 className="font-medium">
            Last {d.messages.length} messages <span className="text-xs font-normal text-muted-foreground">({d.source === "telegram" ? "live from Telegram" : "stored in the panel"})</span>
          </h2>
          {d.note && <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">{d.note}</p>}
          {d.messages.length === 0 && <p className="text-sm text-muted-foreground">No messages.</p>}
          <ul className="space-y-2">
            {d.messages.map((m) => (
              <li key={m.id} className={`flex ${m.side === "fan" ? "justify-start" : "justify-end"}`}>
                <div
                  className={`max-w-[85%] rounded-2xl px-3 py-2 text-sm ${
                    m.side === "fan"
                      ? "rounded-bl-sm bg-secondary"
                      : m.by === "ai"
                        ? "rounded-br-sm bg-primary text-primary-foreground"
                        : "rounded-br-sm border-2 border-amber-400 bg-amber-50 text-amber-950"
                  }`}
                >
                  <div className="mb-0.5 flex items-center gap-1 text-[11px] font-medium opacity-80">
                    {m.side === "fan" ? <User className="size-3" /> : <Bot className="size-3" />}
                    {m.side === "fan" ? "Fan" : m.by === "ai" ? "Model · AI" : "Model · not sent by the AI"}
                    <span className="font-normal">· {when(m.at)}</span>
                  </div>
                  <div className="whitespace-pre-wrap break-words">{m.text ?? <em className="opacity-80">[{m.kind}]</em>}</div>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      {d && (
        <section className="space-y-2 rounded-xl border bg-card p-3">
          <h2 className="font-medium">AI log</h2>
          {d.events.length === 0 ? (
            <p className="text-sm text-muted-foreground">No AI activity logged for this chat (the log started on 5 Nov 2026).</p>
          ) : (
            <ol className="space-y-2 border-l pl-3">
              {d.events.map((e) => (
                <li key={e.id} className="text-sm">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="font-medium">{KIND_LABEL[e.kind] ?? e.kind}</span>
                    <StatusChip status={e.capital_status} />
                    <span className="text-xs text-muted-foreground">{when(e.at)}</span>
                  </div>
                  {e.text && <p className="mt-0.5 whitespace-pre-wrap break-words text-muted-foreground">{e.text}</p>}
                  {e.error && <p className="mt-0.5 whitespace-pre-wrap break-words text-destructive">{e.error}</p>}
                </li>
              ))}
            </ol>
          )}
        </section>
      )}
    </div>
  );
}
