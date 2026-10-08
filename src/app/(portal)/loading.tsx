// Shown while a dashboard's server data loads.
export default function Loading() {
  return (
    <div className="animate-pulse space-y-4" aria-busy="true" aria-label="Loading">
      <div className="h-8 w-40 rounded bg-muted" />
      <div className="h-4 w-64 rounded bg-muted" />
      <div className="grid grid-cols-2 gap-3">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="h-20 rounded-xl bg-muted" />
        ))}
      </div>
      <div className="h-48 rounded-xl bg-muted" />
    </div>
  );
}
