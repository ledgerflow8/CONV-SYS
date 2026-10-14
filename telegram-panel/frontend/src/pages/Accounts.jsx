import { Plus, RefreshCw, Search } from "lucide-react";
import { navigate } from "../router.js";

// Step 0 shell: the list, chips and cards arrive in step 1.
export default function Accounts() {
  return (
    <div className="space-y-4">
      <header className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Accounts</h1>
        <button type="button" aria-label="Refresh" disabled className="rounded-lg p-2 text-muted-foreground">
          <RefreshCw className="size-5" />
        </button>
      </header>
      <label className="flex h-11 items-center gap-2 rounded-lg border bg-card px-3 text-muted-foreground">
        <Search className="size-4" />
        <input disabled placeholder="Search username or phone" className="w-full bg-transparent text-base outline-none" />
      </label>
      <div className="rounded-xl border bg-card p-8 text-center">
        <p className="font-medium">No accounts yet</p>
        <p className="mt-1 text-sm text-muted-foreground">Upload session files or log in with a phone number.</p>
        <button
          type="button"
          onClick={() => navigate("/add")}
          className="mt-4 inline-flex h-10 items-center gap-2 rounded-lg bg-primary px-4 text-sm font-medium text-primary-foreground"
        >
          <Plus className="size-4" />
          Add accounts
        </button>
      </div>
    </div>
  );
}
