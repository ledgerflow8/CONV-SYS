import { requireUser } from "@/lib/auth/session";
import { getSetting } from "@/lib/settings";
import { formatLongDate, tzLabel } from "@/lib/time";

export async function TopBar({ title, emoji }: { title: string; emoji: string }) {
  const [user, timeZone] = await Promise.all([requireUser(), getSetting("timezone")]);

  return (
    <header className="mb-5 space-y-2">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-2xl font-bold tracking-tight">
          {title} <span aria-hidden>{emoji}</span>
        </h1>
        <div
          aria-hidden
          className="grid size-10 shrink-0 place-items-center rounded-full bg-primary text-sm font-semibold text-primary-foreground uppercase"
        >
          {user.username.charAt(0)}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted-foreground">
        <span>{formatLongDate(timeZone)}</span>
        <span aria-hidden>·</span>
        <span>Welcome back, {user.username}</span>
        <span className="rounded-full border bg-background px-2 py-0.5 text-xs font-medium">
          {tzLabel(timeZone)}
        </span>
      </div>
    </header>
  );
}
