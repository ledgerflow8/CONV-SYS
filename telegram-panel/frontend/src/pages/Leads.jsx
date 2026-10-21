import { useCallback, useEffect, useState } from "react";
import { Download, ExternalLink, Search } from "lucide-react";
import { api } from "../api.js";

const FIELD = "h-10 w-full rounded-lg border bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-ring";

function qs(filters) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(filters)) if (v) p.set(k, v);
  return p.toString();
}

function fmtDate(iso) {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

export default function Leads() {
  const [filters, setFilters] = useState({ account_id: "", model: "", from: "", to: "", q: "" });
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  const query = qs(filters);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await api(`/api/leads${query ? `?${query}` : ""}`));
      setError("");
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [query]);

  useEffect(() => {
    const t = setTimeout(load, 200); // light debounce so typing in search doesn't spam the API
    return () => clearTimeout(t);
  }, [load]);

  const set = (patch) => setFilters((f) => ({ ...f, ...patch }));

  const exportCsv = async () => {
    try {
      const res = await fetch(`/api/leads/export${query ? `?${query}` : ""}`, { credentials: "same-origin" });
      if (!res.ok) throw new Error(`Export failed (${res.status})`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = res.headers.get("Content-Disposition")?.match(/filename="(.+?)"/)?.[1] || "converted-leads.csv";
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (e) {
      setError(e.message);
    }
  };

  const leads = data?.leads ?? [];
  const accounts = data?.accounts ?? [];
  const models = data?.models ?? [];
  const total = data?.total ?? 0;

  return (
    <div className="space-y-4">
      <header className="flex items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">Leads</h1>
        <button
          type="button"
          onClick={exportCsv}
          disabled={!leads.length}
          className="inline-flex h-10 items-center gap-1.5 rounded-lg bg-primary px-3 text-sm font-medium text-primary-foreground disabled:opacity-50"
        >
          <Download className="size-4" /> Export CSV
        </button>
      </header>

      {error && <p className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>}

      <section className="space-y-2 rounded-xl border bg-card p-3">
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <input
            value={filters.q}
            onChange={(e) => set({ q: e.target.value })}
            placeholder="Search fan name, @username or ID"
            className={`${FIELD} pl-9`}
          />
        </div>
        <div className="grid grid-cols-2 gap-2">
          <select value={filters.account_id} onChange={(e) => set({ account_id: e.target.value })} className={FIELD}>
            <option value="">All accounts</option>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                @{a.username ?? a.id}
              </option>
            ))}
          </select>
          <select value={filters.model} onChange={(e) => set({ model: e.target.value })} className={FIELD}>
            <option value="">All models</option>
            {models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name ?? `Model ${m.id}`}
              </option>
            ))}
          </select>
          <label className="text-xs text-muted-foreground">
            From
            <input type="date" value={filters.from} onChange={(e) => set({ from: e.target.value })} className={`${FIELD} mt-1`} />
          </label>
          <label className="text-xs text-muted-foreground">
            To
            <input type="date" value={filters.to} onChange={(e) => set({ to: e.target.value })} className={`${FIELD} mt-1`} />
          </label>
        </div>
      </section>

      <p className="text-sm text-muted-foreground">{loading ? "Loading…" : `${total} converted lead${total === 1 ? "" : "s"}`}</p>

      {!loading && total === 0 ? (
        <p className="rounded-xl border bg-card p-4 text-sm text-muted-foreground">No converted leads match these filters yet.</p>
      ) : (
        <div className="overflow-x-auto rounded-xl border bg-card">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-muted/50 text-left text-xs text-muted-foreground">
                <th className="px-3 py-2 font-medium">Fan</th>
                <th className="px-3 py-2 font-medium">Phone</th>
                <th className="px-3 py-2 font-medium">Account</th>
                <th className="px-3 py-2 font-medium">Model</th>
                <th className="px-3 py-2 font-medium">Converted</th>
                <th className="px-3 py-2 font-medium"> </th>
              </tr>
            </thead>
            <tbody>
              {leads.map((l) => (
                <tr key={l.id} className="border-t align-top">
                  <td className="px-3 py-2">
                    <div className="font-medium">{l.fan_name || "—"}</div>
                    <div className="text-xs text-muted-foreground">
                      {l.fan_username ? `@${l.fan_username}` : "no username"} · {l.fan_user_id}
                    </div>
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 tabular-nums">{l.fan_phone || "—"}</td>
                  <td className="whitespace-nowrap px-3 py-2">@{l.account_username ?? "—"}</td>
                  <td className="px-3 py-2">{l.profile_name || "—"}</td>
                  <td className="whitespace-nowrap px-3 py-2 text-muted-foreground">{fmtDate(l.converted_at)}</td>
                  <td className="px-3 py-2">
                    {l.tme_link && (
                      <a
                        href={l.tme_link}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center gap-1 text-primary hover:underline"
                        aria-label={`Open ${l.fan_username} on Telegram`}
                      >
                        <ExternalLink className="size-4" />
                      </a>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
