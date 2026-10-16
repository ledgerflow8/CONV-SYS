import { useCallback, useEffect, useState } from "react";
import { api, setUnauthorizedHandler } from "./api.js";
import { navigate, usePath } from "./router.js";
import Drawer from "./components/Drawer.jsx";
import Login from "./pages/Login.jsx";
import Accounts from "./pages/Accounts.jsx";
import Add from "./pages/Add.jsx";
import Personas from "./pages/Personas.jsx";
import Status from "./pages/Status.jsx";

export const NAV = [
  { href: "/accounts", label: "Accounts", emoji: "📱" },
  { href: "/add", label: "Add accounts", emoji: "➕" },
  { href: "/personas", label: "Personas", emoji: "🎭" },
  { href: "/status", label: "Status", emoji: "📡" },
];

const PAGES = {
  "/accounts": () => <Accounts />,
  "/add": () => <Add />,
  "/personas": () => <Personas />,
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
      <main className="mx-auto w-full max-w-2xl px-4 pt-6 pb-28">
        <Page />
      </main>
      <Drawer items={NAV} path={path} onLogout={logout} />
    </div>
  );
}
