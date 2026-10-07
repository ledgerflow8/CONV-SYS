import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";

export function StatCard({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: React.ReactNode;
  hint?: React.ReactNode;
  tone?: "danger" | "good";
}) {
  return (
    <Card className="gap-1 py-4">
      <CardContent className="px-4">
        <div
          className={cn(
            "text-2xl font-bold tabular-nums",
            tone === "danger" && "text-destructive",
            tone === "good" && "text-emerald-600 dark:text-emerald-400",
          )}
        >
          {value}
        </div>
        <div className="text-xs text-muted-foreground">{label}</div>
        {hint && <div className="mt-1 text-xs text-muted-foreground">{hint}</div>}
      </CardContent>
    </Card>
  );
}

export function WalletBanner() {
  return (
    <div className="mb-4 flex gap-2 rounded-xl border border-red-300 bg-red-50 p-3 text-sm text-red-900 dark:border-red-800 dark:bg-red-950 dark:text-red-100">
      <span aria-hidden>⚠️</span>
      <p>
        <strong>Payout address missing.</strong> Add your wallet so you can get paid.
      </p>
    </div>
  );
}
