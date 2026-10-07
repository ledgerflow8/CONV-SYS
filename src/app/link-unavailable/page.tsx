import type { Metadata } from "next";
import { LinkIcon } from "lucide-react";

export const metadata: Metadata = { title: "Link unavailable", robots: { index: false } };

export default function LinkUnavailablePage() {
  return (
    <div className="grid min-h-dvh place-items-center bg-muted/40 px-4">
      <div className="max-w-sm text-center">
        <div className="mx-auto mb-4 grid size-14 place-items-center rounded-2xl bg-muted text-muted-foreground">
          <LinkIcon className="size-7" />
        </div>
        <h1 className="mb-2 text-xl font-semibold">Link unavailable</h1>
        <p className="text-sm text-muted-foreground">This link isn&apos;t active right now.</p>
      </div>
    </div>
  );
}
