import { useCallback, useEffect, useState } from "react";
import { api, setUnauthorizedHandler } from "./api.js";
import { navigate, usePath } from "./router.js";
import Drawer from "./components/Drawer.jsx";
import Login from "./pages/Login.jsx";
import Accounts from "./pages/Accounts.jsx";
import Add from "./pages/Add.jsx";
import Personas from "./pages/Personas.jsx";
import Leads from "./pages/Leads.jsx";
import Status from "./pages/Status.jsx";

export const NAV = [
  { href: "/accounts", label: "Accounts", emoji: "📱" },
  { href: "/add", label: "Add accounts", emoji: "➕" },
  { href: "/personas", label: "Personas", emoji: "🎭" },
  { href: "/leads", label: "Leads", emoji: "⭐" },
  { href: "/status", label: "Status", emoji: "📡" },
];

const PAGES = {
  "/accounts": () => <Accounts />,
  "/add": () => <Add />,
  "/personas": () => <Personas />,
  "/leads": () => <Leads />,
  "/status": () => <Status />,
};

export default function App() {
  const path = usePath();
  const [authed, setAuthed] = useState(null); // null = checking

  const signOut = useCallback(() => setAuthed(false), []);
  useEffect(() => setUnauthorizedHandler(signOut), [signOut]);

  useEffect(() => {
    api("/api/auth/me")
      .then(() => setAuthed(true))
      .catch(() => setAuthed(false));
  }, []);

  useEffect(() => {
    if (authed && !PAGES[path]) navigate("/accounts");
  }, [authed, path]);

  if (authed === null) return <div className="min-h-dvh bg-muted/40" />;
  if (!authed) return <Login onDone={() => setAuthed(true)} />;

  const logout = async () => {
    await api("/api/auth/logout", { method: "POST" }).catch(() => {});
    setAuthed(false);
  };

  const Page = PAGES[path] ?? PAGES["/accounts"];
  return (
    <div className="min-h-dvh bg-muted/40">
      <GlobalBanner />
      <main className="mx-auto w-full max-w-2xl px-4 pt-6 pb-28">
        <Page />
      </main>
      <Drawer items={NAV} path={path} onLogout={logout} />
    </div>
  );
}

// Site-wide alerts (every page), so a depleted-credits / failing-sync state can't be missed.
function GlobalBanner() {
  const [status, setStatus] = useState(null);
  useEffect(() => {
    const load = () => api("/api/system/status").then(setStatus).catch(() => {});
    load();
    const t = setInterval(() => document.visibilityState === "visible" && load(), 15000);
    return () => clearInterval(t);
  }, []);
  const msgs = [];
  if (status?.ai?.credit_over_until) msgs.push("Capitalbot AI credits are depleted — AI replies are paused. They resume automatically when credits return.");
  if (status?.portal && (status.portal.failed > 0 || status.portal.last_error)) msgs.push("Portal sync is failing — see Status.");
  if (!msgs.length) return null;
  return (
    <div className="sticky top-0 z-40 space-y-px">
      {msgs.map((m) => (
        <p key={m} role="alert" className="bg-destructive px-4 py-2 text-center text-sm font-medium text-white">{m}</p>
      ))}
    </div>
  );
}
