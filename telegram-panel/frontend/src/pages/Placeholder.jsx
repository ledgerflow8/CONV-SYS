export default function Placeholder({ title, note }) {
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold">{title}</h1>
      <div className="rounded-xl border bg-card p-6 text-sm text-muted-foreground">{note}</div>
    </div>
  );
}
