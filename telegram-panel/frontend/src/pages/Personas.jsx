import { useCallback, useEffect, useState } from "react";
import { Pencil, Plus, Trash2 } from "lucide-react";
import { api } from "../api.js";
import Dialog from "../components/Dialog.jsx";
import Toggle from "../components/Toggle.jsx";

// The persona override fields Capitalbot accepts (PLAN.md §3), grouped for the editor (§6.5).
const GROUPS = [
  {
    title: "Identity",
    fields: [
      ["modelName", "Name", "text"],
      ["modelAge", "Age", "text"],
      ["city", "City", "text"],
      ["timezone", "Timezone", "text"],
      ["appearance", "Appearance", "area"],
      ["hobbies", "Hobbies", "area"],
      ["language", "Language", "text"],
      ["detectLanguage", "Auto-detect language", "bool"],
      ["matchLocation", "Match fan's location", "bool"],
      ["conversationSource", "Conversation source", "text"],
    ],
  },
  {
    title: "Style",
    fields: [
      ["chattingStyle", "Chatting style (0–100)", "number"],
      ["interestLevel", "Interest level", "select:Low,Medium,High"],
      ["phaseGoal", "Phase goal", "text"],
      ["dayTimeActivity", "Daytime activity", "text"],
      ["nightTimeActivity", "Nighttime activity", "text"],
    ],
  },
  {
    title: "Media",
    fields: [
      ["photoRate", "Photo rate (0–100)", "number"],
      ["image", "Send images", "bool"],
      ["video", "Send videos", "bool"],
      ["audio", "Send voice notes", "bool"],
    ],
  },
  {
    title: "CTA",
    fields: [
      ["ctaInfo", "CTA message", "area"],
      ["affiliate", "Affiliate code", "text"],
    ],
  },
];

export default function Personas() {
  const [profiles, setProfiles] = useState(null);
  const [catalog, setCatalog] = useState(null);
  const [error, setError] = useState("");
  const [editing, setEditing] = useState(null); // a profile, or {} for new

  const load = useCallback(async () => {
    try {
      const [p, c] = await Promise.all([api("/api/profiles"), api("/api/capital/catalog").catch(() => ({ configured: false, models: [], presets: [] }))]);
      setProfiles(p.profiles);
      setCatalog(c);
      setError("");
    } catch (e) {
      setError(e.message);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <div className="space-y-4">
      <header className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Personas</h1>
        <button
          type="button"
          onClick={() => setEditing({})}
          className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-primary px-3 text-sm font-medium text-primary-foreground"
        >
          <Plus className="size-4" /> New
        </button>
      </header>

      {error && <p className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>}
      {catalog && !catalog.configured && (
        <p className="rounded-lg bg-amber-500/10 px-3 py-2 text-sm text-amber-700">
          No Capitalbot license key is set, so the model and preset lists are empty. Set CAPITAL_LICENSE_KEY and you can pick them from a dropdown; for now, enter the IDs by hand.
        </p>
      )}

      {profiles && profiles.length === 0 && (
        <div className="rounded-xl border bg-card p-8 text-center">
          <p className="font-medium">No personas yet</p>
          <p className="mt-1 text-sm text-muted-foreground">A persona ties an account to a Capitalbot model and preset.</p>
        </div>
      )}

      <div className="space-y-3">
        {profiles?.map((p) => (
          <div key={p.id} className="flex items-center justify-between gap-3 rounded-xl border bg-card p-3">
            <div className="min-w-0">
              <div className="truncate font-medium">{p.name}</div>
              <div className="truncate text-sm text-muted-foreground">
                model {p.capital_model_id} · preset {p.capital_preset_id} · {p.accounts} account{p.accounts === 1 ? "" : "s"}
              </div>
            </div>
            <button type="button" aria-label="Edit" onClick={() => setEditing(p)} className="rounded-lg p-2 hover:bg-secondary">
              <Pencil className="size-5" />
            </button>
          </div>
        ))}
      </div>

      {editing && <Editor profile={editing} catalog={catalog} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); load(); }} />}
    </div>
  );
}

function Editor({ profile, catalog, onClose, onSaved }) {
  const isNew = !profile.id;
  const [name, setName] = useState(profile.name || "");
  const [modelId, setModelId] = useState(profile.capital_model_id ?? "");
  const [presetId, setPresetId] = useState(profile.capital_preset_id ?? "");
  const [ov, setOv] = useState(profile.overrides || {});
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const hasCatalog = catalog?.configured && catalog.models.length > 0;

  const setField = (key, value) => setOv((o) => (value === "" || value === null ? omit(o, key) : { ...o, [key]: value }));

  const save = async () => {
    setBusy(true);
    setError("");
    try {
      const body = { name, capital_model_id: Number(modelId), capital_preset_id: Number(presetId), overrides: ov };
      await api(isNew ? "/api/profiles" : `/api/profiles/${profile.id}`, { method: isNew ? "POST" : "PATCH", body });
      onSaved();
    } catch (e) {
      setError(e.message);
      setBusy(false);
    }
  };

  const del = async () => {
    setBusy(true);
    setError("");
    try {
      await api(`/api/profiles/${profile.id}`, { method: "DELETE" });
      onSaved();
    } catch (e) {
      setError(e.message);
      setBusy(false);
    }
  };

  return (
    <Dialog title={isNew ? "New persona" : "Edit persona"} onClose={onClose}>
      <div className="max-h-[70vh] space-y-4 overflow-y-auto pr-1 text-sm">
        <Field label="Persona name">
          <input value={name} onChange={(e) => setName(e.target.value)} className={inputCls} placeholder="e.g. Lily — flirty" />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Model">
            {hasCatalog ? (
              <select value={modelId} onChange={(e) => setModelId(e.target.value)} className={inputCls}>
                <option value="">Pick…</option>
                {catalog.models.map((m) => (
                  <option key={m.id} value={m.id}>{m.name} (#{m.id})</option>
                ))}
              </select>
            ) : (
              <input type="number" value={modelId} onChange={(e) => setModelId(e.target.value)} className={inputCls} placeholder="model id" />
            )}
          </Field>
          <Field label="Preset">
            {hasCatalog ? (
              <select value={presetId} onChange={(e) => setPresetId(e.target.value)} className={inputCls}>
                <option value="">Pick…</option>
                {catalog.presets.map((pr) => (
                  <option key={pr.id} value={pr.id}>{pr.name} (#{pr.id})</option>
                ))}
              </select>
            ) : (
              <input type="number" value={presetId} onChange={(e) => setPresetId(e.target.value)} className={inputCls} placeholder="preset id" />
            )}
          </Field>
        </div>

        <p className="text-xs text-muted-foreground">Overrides are optional — leave a field blank to use the preset's own value.</p>
        {GROUPS.map((g) => (
          <fieldset key={g.title} className="space-y-2 rounded-lg border p-3">
            <legend className="px-1 text-xs font-medium text-muted-foreground">{g.title}</legend>
            {g.fields.map(([key, label, type]) => (
              <OverrideField key={key} name={key} label={label} type={type} value={ov[key]} onChange={(v) => setField(key, v)} />
            ))}
          </fieldset>
        ))}

        {error && <p className="text-destructive">{error}</p>}
        <div className="flex gap-2 pt-1">
          {!isNew && (
            <button type="button" onClick={del} disabled={busy} aria-label="Delete persona" className="rounded-lg border border-destructive/40 px-3 text-destructive hover:bg-destructive/10">
              <Trash2 className="size-4" />
            </button>
          )}
          <button type="button" onClick={onClose} className="h-10 flex-1 rounded-lg border font-medium">Cancel</button>
          <button
            type="button"
            onClick={save}
            disabled={busy || !name || modelId === "" || presetId === ""}
            className="h-10 flex-1 rounded-lg bg-primary font-medium text-primary-foreground disabled:opacity-50"
          >
            {busy ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </Dialog>
  );
}

const inputCls = "h-10 w-full rounded-lg border bg-background px-3 outline-none focus:ring-2 focus:ring-ring";

function Field({ label, children }) {
  return (
    <label className="block space-y-1">
      <span className="text-xs text-muted-foreground">{label}</span>
      {children}
    </label>
  );
}

function OverrideField({ name, label, type, value, onChange }) {
  if (type === "bool") {
    return (
      <label className="flex items-center justify-between gap-3 py-1">
        <span>{label}</span>
        <Toggle on={value === true} label={label} onChange={(v) => onChange(v)} />
      </label>
    );
  }
  if (type === "area") {
    return (
      <Field label={label}>
        <textarea value={value ?? ""} onChange={(e) => onChange(e.target.value)} rows={2} className="w-full rounded-lg border bg-background px-3 py-2 outline-none focus:ring-2 focus:ring-ring" />
      </Field>
    );
  }
  if (type.startsWith("select:")) {
    const opts = type.slice(7).split(",");
    return (
      <Field label={label}>
        <select value={value ?? ""} onChange={(e) => onChange(e.target.value)} className={inputCls}>
          <option value="">—</option>
          {opts.map((o) => (
            <option key={o} value={o}>{o}</option>
          ))}
        </select>
      </Field>
    );
  }
  return (
    <Field label={label}>
      <input
        type={type === "number" ? "number" : "text"}
        value={value ?? ""}
        onChange={(e) => onChange(type === "number" ? (e.target.value === "" ? "" : Number(e.target.value)) : e.target.value)}
        className={inputCls}
      />
    </Field>
  );
}

function omit(obj, key) {
  const { [key]: _drop, ...rest } = obj;
  return rest;
}
