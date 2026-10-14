import { useEffect, useState } from "react";
import { LogOut, Menu, X } from "lucide-react";
import { navigate } from "../router.js";

// Floating menu button (bottom right) + left drawer, as in the portal.
export default function Drawer({ items, path, onLogout }) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    const onKey = (e) => e.key === "Escape" && setOpen(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  const go = (href) => (e) => {
    e.preventDefault();
    setOpen(false);
    navigate(href);
  };

  return (
    <>
      <button
        type="button"
        aria-label="Open menu"
        onClick={() => setOpen(true)}
        className="fixed right-5 bottom-5 z-40 grid size-14 place-items-center rounded-full bg-primary text-primary-foreground shadow-lg transition active:scale-95"
      >
        <Menu className="size-6" />
      </button>

      <div
        aria-hidden={!open}
        onClick={() => setOpen(false)}
        className={`fixed inset-0 z-50 bg-black/40 transition-opacity ${open ? "opacity-100" : "pointer-events-none opacity-0"}`}
      />
      <aside
        role="dialog"
        aria-modal="true"
        aria-label="Menu"
        className={`fixed inset-y-0 left-0 z-50 flex w-72 flex-col bg-background shadow-xl transition-transform ${
          open ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        <div className="flex items-center justify-between border-b px-5 py-5">
          <div>
            <div className="text-base font-semibold">Telegram Panel</div>
            <div className="text-sm text-muted-foreground">Accounts &amp; AI</div>
          </div>
          <button type="button" aria-label="Close menu" onClick={() => setOpen(false)} className="rounded-lg p-2 hover:bg-secondary">
            <X className="size-5" />
          </button>
        </div>
        <nav className="flex-1 space-y-1 overflow-y-auto p-3">
          {items.map((item) => (
            <a
              key={item.href}
              href={item.href}
              onClick={go(item.href)}
              className={`flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium ${
                path === item.href ? "bg-secondary" : "hover:bg-secondary/60"
              }`}
            >
              <span aria-hidden>{item.emoji}</span>
              {item.label}
            </a>
          ))}
        </nav>
        <div className="border-t p-3">
          <button
            type="button"
            onClick={onLogout}
            className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium text-destructive hover:bg-destructive/10"
          >
            <LogOut className="size-4" />
            Log Out
          </button>
        </div>
      </aside>
    </>
  );
}
