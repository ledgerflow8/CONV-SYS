import { useEffect } from "react";

// In-page modal dialog (never window.confirm/alert — CLAUDE.md).
export default function Dialog({ title, children, onClose }) {
  useEffect(() => {
    const onKey = (e) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-[60] grid place-items-end sm:place-items-center bg-black/40 p-0 sm:p-4" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-md rounded-t-2xl sm:rounded-2xl border bg-card p-5 shadow-xl"
      >
        {title && <h2 className="text-lg font-semibold">{title}</h2>}
        <div className="mt-3">{children}</div>
      </div>
    </div>
  );
}
