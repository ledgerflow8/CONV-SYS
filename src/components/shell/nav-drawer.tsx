"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { LifeBuoy, LogOut, Menu } from "lucide-react";
import { Sheet, SheetContent, SheetDescription, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { logout } from "@/lib/auth/actions";
import { cn } from "@/lib/utils";
import type { NavItem } from "./nav";

export function NavDrawer({
  items,
  username,
  roleLabel,
  supportUrl,
}: {
  items: NavItem[];
  username: string;
  roleLabel: string;
  supportUrl: string | null;
}) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger
        aria-label="Open menu"
        className="fixed right-5 bottom-5 z-40 grid size-14 place-items-center rounded-full bg-primary text-primary-foreground shadow-lg transition active:scale-95"
      >
        <Menu className="size-6" />
      </SheetTrigger>
      <SheetContent side="left" className="flex w-72 flex-col gap-0 p-0">
        <div className="border-b px-5 py-5">
          <SheetTitle className="text-base">{username}</SheetTitle>
          <SheetDescription>{roleLabel}</SheetDescription>
        </div>
        <nav className="flex-1 space-y-1 overflow-y-auto p-3">
          {items.map((item) => {
            const active = pathname === item.href;
            return (
              <Link
                key={item.href}
                href={item.href}
                onClick={() => setOpen(false)}
                className={cn(
                  "flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium",
                  active ? "bg-secondary" : "hover:bg-secondary/60",
                )}
              >
                <span aria-hidden>{item.emoji}</span>
                {item.label}
              </Link>
            );
          })}
        </nav>
        <div className="space-y-1 border-t p-3">
          {supportUrl ? (
            <a
              href={supportUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium hover:bg-secondary/60"
            >
              <LifeBuoy className="size-4" />
              Report a Problem
            </a>
          ) : (
            <button
              type="button"
              disabled
              title="Support contact not set up yet"
              className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium text-muted-foreground"
            >
              <LifeBuoy className="size-4" />
              Report a Problem
            </button>
          )}
          <form action={logout}>
            <button
              type="submit"
              className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium text-destructive hover:bg-destructive/10"
            >
              <LogOut className="size-4" />
              Log Out
            </button>
          </form>
        </div>
      </SheetContent>
    </Sheet>
  );
}
