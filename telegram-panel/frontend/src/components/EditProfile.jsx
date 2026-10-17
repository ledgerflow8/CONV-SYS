import { useEffect, useRef, useState } from "react";
import { Check, Loader2, Pencil, Upload, UserRound, X } from "lucide-react";
import { api } from "../api.js";

const NAME_MAX = 64;
const BIO_MAX = 70;
const USERNAME_RE = /^[A-Za-z0-9_]{5,32}$/;

// Edit an account's Telegram profile (name, bio, username, photo) over its live connection.
export default function EditProfile({ accountId, connected, currentUsername, hasAvatar, onSaved }) {
  const [open, setOpen] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [form, setForm] = useState({ first_name: "", last_name: "", bio: "", username: "" });
  const [photo, setPhoto] = useState(null); // File
  const [preview, setPreview] = useState(null); // object URL
  const [removePhoto, setRemovePhoto] = useState(false);
  const [serverAvatar, setServerAvatar] = useState(!!hasAvatar); // is a photo stored server-side?
  const [avatarVer, setAvatarVer] = useState(() => Date.now()); // cache-buster for this account's avatar URL
  const [uname, setUname] = useState({ state: "idle", reason: null }); // idle|checking|ok|taken|invalid
  const [error, setError] = useState("");
  const [toast, setToast] = useState("");
  const [busy, setBusy] = useState(false);
  const checkTimer = useRef(null);
  const toastTimer = useRef(null);
  const fileRef = useRef(null);

  const loadProfile = () =>
    api(`/api/accounts/${accountId}/profile`)
      .then((p) => {
        setForm({ first_name: p.first_name || "", last_name: p.last_name || "", bio: p.bio || "", username: p.username || "" });
        setLoaded(true);
      })
      .catch((e) => setError(e.message));

  useEffect(() => {
    if (open && !loaded) loadProfile();
  }, [open, loaded, accountId]);

  useEffect(() => () => clearTimeout(toastTimer.current), []);

  const flash = (msg) => {
    setToast(msg);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(""), 2500);
  };

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  // Debounced username availability check against Telegram.
  const onUsername = (e) => {
    const v = e.target.value.replace(/^@/, "");
    setForm((f) => ({ ...f, username: v }));
    clearTimeout(checkTimer.current);
    if (!v || v.toLowerCase() === (currentUsername || "").toLowerCase()) return setUname({ state: "idle", reason: null });
    if (!USERNAME_RE.test(v)) return setUname({ state: "invalid", reason: "invalid" });
    setUname({ state: "checking", reason: null });
    checkTimer.current = setTimeout(async () => {
      try {
        const r = await api(`/api/accounts/${accountId}/username-check`, { method: "POST", body: { username: v } });
        setUname({ state: r.available ? "ok" : r.reason, reason: r.reason });
      } catch (err) {
        setError(err.message);
        setUname({ state: "idle", reason: null });
      }
    }, 400);
  };

  const pickPhoto = (e) => {
    const file = e.target.files?.[0];
    e.target.value = ""; // let the same file be re-picked later
    if (!file) return;
    if (!["image/jpeg", "image/png"].includes(file.type)) return setError("The photo must be a JPG or PNG.");
    setError("");
    setPhoto(file);
    setRemovePhoto(false);
    setPreview((old) => {
      if (old) URL.revokeObjectURL(old);
      return URL.createObjectURL(file);
    });
  };

  const stageRemove = () => {
    setError("");
    setPhoto(null);
    setPreview((old) => {
      if (old) URL.revokeObjectURL(old);
      return null;
    });
    setRemovePhoto(true);
  };

  const undoRemove = () => setRemovePhoto(false);

  const usernameChanged = form.username && form.username.toLowerCase() !== (currentUsername || "").toLowerCase();
  const blocked = busy || uname.state === "checking" || (usernameChanged && (uname.state === "taken" || uname.state === "invalid"));

  const showAvatar = !removePhoto && (preview || serverAvatar);
  const avatarSrc = preview || `/api/accounts/${accountId}/avatar?v=${avatarVer}`;
  const canRemove = !removePhoto && (serverAvatar || !!photo);

  const save = async () => {
    setBusy(true);
    setError("");
    const removed = removePhoto;
    const changedPhoto = !!photo && !removePhoto;
    try {
      const fd = new FormData();
      fd.append("first_name", form.first_name.slice(0, NAME_MAX));
      fd.append("last_name", form.last_name.slice(0, NAME_MAX));
      fd.append("bio", form.bio.slice(0, BIO_MAX));
      fd.append("username", form.username);
      fd.append("remove_photo", removePhoto ? "true" : "false");
      if (changedPhoto) fd.append("photo", photo);
      await api(`/api/accounts/${accountId}/profile`, { method: "POST", body: fd });
      // Clear the staged photo and bust the avatar cache so the new state shows at once.
      setPhoto(null);
      setRemovePhoto(false);
      setPreview((old) => {
        if (old) URL.revokeObjectURL(old);
        return null;
      });
      if (removed) setServerAvatar(false);
      else if (changedPhoto) setServerAvatar(true);
      setAvatarVer(Date.now());
      await loadProfile();
      flash(removed ? "Photo removed" : changedPhoto ? "Photo updated" : "Profile saved");
      onSaved();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  if (!connected) return <p className="text-xs text-muted-foreground">Power the account on to edit its profile.</p>;

  if (!open)
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex min-h-11 w-full items-center justify-center gap-2 rounded-lg border px-3 font-medium hover:bg-secondary"
      >
        <Pencil className="size-4" /> Edit profile
      </button>
    );

  return (
    <div className="space-y-3 rounded-lg border p-3">
      <div className="flex items-center justify-between">
        <h3 className="font-medium">Edit profile</h3>
        <button type="button" onClick={() => setOpen(false)} aria-label="Close editor" className="rounded p-1 hover:bg-secondary">
          <X className="size-4" />
        </button>
      </div>

      {!loaded && !error ? (
        <p className="text-sm text-muted-foreground">Loading current profile…</p>
      ) : (
        <>
          <div className="flex items-center gap-3">
            {showAvatar ? (
              <img
                key={avatarSrc}
                src={avatarSrc}
                alt=""
                onError={(e) => (e.currentTarget.style.visibility = "hidden")}
                className="size-14 shrink-0 rounded-full border object-cover"
              />
            ) : (
              <div className="grid size-14 shrink-0 place-items-center rounded-full border bg-secondary text-muted-foreground">
                <UserRound className="size-6" />
              </div>
            )}
            {/* Hidden file input, triggered by its own button — never wrapped in a label, so its
                tap area can't overlap the Remove button (the iOS Safari bug). */}
            <input ref={fileRef} type="file" accept="image/jpeg,image/png" onChange={pickPhoto} className="hidden" />
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => fileRef.current?.click()}
                className="inline-flex min-h-11 items-center gap-1.5 rounded-lg border px-3 text-sm font-medium hover:bg-secondary"
              >
                <Upload className="size-4" /> Change photo
              </button>
              {canRemove && (
                <button
                  type="button"
                  onClick={stageRemove}
                  className="inline-flex min-h-11 items-center gap-1.5 rounded-lg border border-destructive/40 px-3 text-sm font-medium text-destructive hover:bg-destructive/10"
                >
                  <X className="size-4" /> Remove photo
                </button>
              )}
            </div>
          </div>

          {removePhoto && (
            <p className="flex items-center justify-between gap-2 rounded bg-amber-500/10 px-2 py-1.5 text-xs text-amber-700">
              <span>Photo will be removed when you save.</span>
              <button type="button" onClick={undoRemove} className="shrink-0 font-medium underline">
                Undo
              </button>
            </p>
          )}

          <Field label="First name">
            <input value={form.first_name} onChange={set("first_name")} maxLength={NAME_MAX} className={inputCls} />
          </Field>
          <Field label="Last name">
            <input value={form.last_name} onChange={set("last_name")} maxLength={NAME_MAX} className={inputCls} />
          </Field>
          <Field label={`Bio (${form.bio.length}/${BIO_MAX})`}>
            <textarea value={form.bio} onChange={set("bio")} maxLength={BIO_MAX} rows={2} className={inputCls} />
          </Field>
          <Field label="Username">
            <div className="flex items-center gap-2">
              <span className="text-muted-foreground">@</span>
              <input value={form.username} onChange={onUsername} maxLength={32} className={inputCls} placeholder="5–32 chars, a–z 0–9 _" />
              {uname.state === "checking" && <Loader2 className="size-4 animate-spin text-muted-foreground" />}
              {uname.state === "ok" && <Check className="size-4 text-emerald-600" />}
            </div>
            {usernameChanged && uname.state === "taken" && <span className="text-xs text-destructive">That username is taken.</span>}
            {usernameChanged && uname.state === "invalid" && (
              <span className="text-xs text-destructive">5–32 characters, letters, numbers and underscore only.</span>
            )}
          </Field>

          {error && <p className="rounded bg-destructive/10 px-2 py-1.5 text-sm text-destructive">{error}</p>}

          <button
            type="button"
            onClick={save}
            disabled={blocked}
            className="inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-lg bg-primary font-medium text-primary-foreground disabled:opacity-50"
          >
            {busy && <Loader2 className="size-4 animate-spin" />}
            {busy ? "Saving…" : "Save changes"}
          </button>
        </>
      )}

      {toast && (
        <div className="fixed inset-x-0 bottom-6 z-50 flex justify-center px-4" role="status" aria-live="polite">
          <div className="inline-flex items-center gap-2 rounded-full bg-foreground px-4 py-2 text-sm font-medium text-background shadow-lg">
            <Check className="size-4" /> {toast}
          </div>
        </div>
      )}
    </div>
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
