"use client";

// Something failed while rendering a page: show a way out instead of a blank screen.
import { useEffect } from "react";
import { Button } from "@/components/ui/button";

export default function PortalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);
  return (
    <div className="space-y-3 py-16 text-center">
      <h1 className="text-xl font-semibold">Something went wrong</h1>
      <p className="text-sm text-muted-foreground">
        Try again. If it keeps happening, use Report a Problem in the menu{error.digest ? ` and mention code ${error.digest}` : ""}.
      </p>
      <Button onClick={reset}>Try again</Button>
    </div>
  );
}
