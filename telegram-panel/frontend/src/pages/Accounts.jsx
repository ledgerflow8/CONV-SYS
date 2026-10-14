import { useCallback, useEffect, useRef, useState } from "react";
import { Plus, RefreshCw, Search } from "lucide-react";
import { api } from "../api.js";
import { navigate } from "../router.js";
import AccountCard from "../components/AccountCard.jsx";
import AccountSheet from "../components/AccountSheet.jsx";

const CHIPS = [
  { key: "all", label: "All" },
  { key: "green", label: "Active", dot: "bg-emerald-500" },
  { key: "amber", label: "Quiet", dot: "bg-amber-500" },
  { key: "red", label: "Dead", dot: "bg-red-500" },
  { key: "grey", label: "Off", dot: "bg-muted-foreground/50" },
];

export default function Accounts() {
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState("all");
  const [openId, setOpenId] = useState(null);
  const timer = useRef(null);

  const load = useCallback(async (query) => {
    try {
      setData(await api(`/api/accounts${query ? `?q=${encodeURIComponent(query)}` : ""}`));
      setError("");
    } catch (e) {
      setError(e.message);
    }
  }, []);

  // Debounced search.
  useEffect(() => {
    const id = setTimeout(() => load(q), q ? 250 : 0);
    return () => clearTimeout(id);
  }, [q, load]);

  // Poll every 10s while the tab is visible.
  useEffect(() => {
    const tick = () => document.visibilityState === "visible" && load(q);
    timer.current = setInterval(tick, 10000);
    return () => clearInterval(timer.current);
  }, [q, load]);

  const accounts = data?.accounts ?? [];
  const shown = filter === "all" ? accounts : accounts.filter((a) => a.color === filter);

  return (
    <div className="space-y-4">
      <header className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Accounts</h1>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => navigate("/add")}
            className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-primary px-3 text-sm font-medium text-primary-foreground"
          >
            <Plus className="size-4" /> Add
          </button>
          <button type="button" aria-label="Refresh" onClick={() => load(q)} className="rounded-lg p-2 hover:bg-secondary">
            <RefreshCw className="size-5" />
          </button>
        </div>
      </header>

      <label className="flex h-11 items-center gap-2 rounded-lg border bg-card px-3">
        <Search className="size-4 text-muted-foreground" />
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search username or phone"
          className="w-full bg-transparent text-base outline-none"
        />
      </label>

      <div className="flex gap-2 overflow-x-auto pb-1">
        {CHIPS.map((c) => (
          <button
            key={c.key}
            type="button"
            onClick={() => setFilter(c.key)}
            className={`flex shrink-0 items-center gap-1.5 rounded-full border px-3 py-1.5 text-sm ${
              filter === c.key ? "border-primary bg-secondary font-medium" : ""
            }`}
          >
            {c.dot && <span className={`size-2 rounded-full ${c.dot}`} />}
            {c.label}
            <span className="text-muted-foreground">{data?.counts?.[c.key] ?? 0}</span>
          </button>
        ))}
      </div>

      {error && <p className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>}

      {data && shown.length === 0 && (
        <div className="rounded-xl border bg-card p-8 text-center">
          <p className="font-medium">{accounts.length ? "Nothing matches" : "No accounts yet"}</p>
          <p className="mt-1 text-sm text-muted-foreground">
            {accounts.length ? "Try another search or filter." : "Upload session files or log in with a phone number."}
          </p>
          {!accounts.length && (
            <button
              type="button"
              onClick={() => navigate("/add")}
              className="mt-4 inline-flex h-10 items-center gap-2 rounded-lg bg-primary px-4 text-sm font-medium text-primary-foreground"
            >
              <Plus className="size-4" /> Add accounts
            </button>
          )}
        </div>
      )}

      <div className="space-y-3">
        {shown.map((a) => (
          <AccountCard key={a.id} account={a} onChanged={() => load(q)} onOpen={() => setOpenId(a.id)} />
        ))}
      </div>

      {openId !== null && <AccountSheet accountId={openId} onClose={() => setOpenId(null)} onChanged={() => load(q)} />}
    </div>
  );
}
