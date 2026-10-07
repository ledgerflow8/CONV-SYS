// "Etc/GMT-2" → "GMT +2"
export function tzLabel(timeZone: string, at = new Date()): string {
  const name =
    new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "shortOffset" })
      .formatToParts(at)
      .find((p) => p.type === "timeZoneName")?.value ?? "GMT";
  return name.replace(/^GMT(?=[+-])/, "GMT ");
}

export function formatLongDate(timeZone: string, at = new Date()): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone,
    weekday: "long",
    day: "numeric",
    month: "long",
  }).format(at);
}
