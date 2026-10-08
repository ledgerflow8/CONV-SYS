import Link from "next/link";

export default function NotFound() {
  return (
    <div className="grid min-h-dvh place-items-center bg-muted/40 px-4 text-center">
      <div className="space-y-2">
        <h1 className="text-xl font-semibold">Page not found</h1>
        <p className="text-sm text-muted-foreground">That page doesn&apos;t exist or you don&apos;t have access to it.</p>
        <Link href="/" className="text-sm font-medium underline">
          Go to your dashboard
        </Link>
      </div>
    </div>
  );
}
