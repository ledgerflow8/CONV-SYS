// "Etc/GMT-2" → "GMT +2"
export function tzLabel(timeZone: string, at = new Date()): string {
  const name =
    new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "shortOffset" })
      .formatToParts(at)
      .find((p) => p.type === "timeZoneName")?.value ?? "GMT";
  return name.replace(/^GMT(?=[+-])/, "GMT ");
}

/** "5 Oct – 11 Oct" for a [start, end) period in the org timezone. */
export function formatPeriod(p: { startsAt: Date; endsAt: Date }, timeZone: string): string {
  const f = new Intl.DateTimeFormat("en-GB", { timeZone, day: "numeric", month: "short" });
  return `${f.format(p.startsAt)} – ${f.format(new Date(p.endsAt.getTime() - 1))}`;
}

/** "Mon 12 Oct" */
export function formatDay(at: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-GB", { timeZone, weekday: "short", day: "numeric", month: "short" }).format(at);
}

/** "Wed 7 Oct, 14:05" in the org timezone. */
export function formatDateTime(at: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone,
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(at);
}

export function formatLongDate(timeZone: string, at = new Date()): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone,
    weekday: "long",
    day: "numeric",
    month: "long",
  }).format(at);
}
