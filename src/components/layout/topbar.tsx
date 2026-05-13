"use client";

import {
  Dropdown,
  DropdownContent,
  DropdownLabel,
  DropdownSeparator,
  DropdownTrigger,
} from "@/components/ui/dropdown";
import { useStackStore } from "@/lib/store";

export function Topbar({
  title,
  breadcrumb,
  actions,
}: {
  title?: string;
  breadcrumb?: { label: string; href?: string }[];
  actions?: React.ReactNode;
}) {
  const { authUser, logout } = useStackStore();

  const initials = authUser
    ? authUser.name
        .split(/\s+/)
        .map((p) => p[0])
        .join("")
        .slice(0, 2)
        .toUpperCase()
    : "??";

  return (
    <header className="sticky top-0 z-30 flex h-14 items-center justify-between gap-4 border-b border-white/[0.06] bg-background/70 px-5 backdrop-blur-md">
      <div className="flex items-center gap-1.5 min-w-0">
        {breadcrumb ? (
          <nav className="flex items-center gap-1.5 text-xs text-muted-foreground min-w-0">
            {breadcrumb.map((b, i) => (
              <span key={i} className="flex items-center gap-1.5 min-w-0">
                {i > 0 ? <span className="text-white/20">/</span> : null}
                {b.href ? (
                  <a href={b.href} className="truncate hover:text-foreground transition-colors">
                    {b.label}
                  </a>
                ) : (
                  <span className="truncate text-foreground">{b.label}</span>
                )}
              </span>
            ))}
          </nav>
        ) : title ? (
          <h1 className="text-sm font-medium">{title}</h1>
        ) : null}
      </div>

      <div className="flex items-center gap-3">
        {actions}

        <Dropdown>
          <DropdownTrigger>
            <button
              type="button"
              className="h-8 w-8 rounded-full bg-gradient-to-br from-brand-400 to-purple-500 ring-2 ring-white/10 grid place-items-center text-[10px] font-semibold"
              aria-label="Account menu"
            >
              {initials}
            </button>
          </DropdownTrigger>
          <DropdownContent align="end">
            <DropdownLabel>Signed in as</DropdownLabel>
            <div className="px-2.5 pb-2 text-xs font-medium">
              {authUser?.email ?? "—"}
            </div>
            <DropdownSeparator />
            <a
              href="/settings"
              className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-xs text-muted-foreground hover:bg-white/[0.05] hover:text-foreground"
            >
              Settings
            </a>
            <DropdownSeparator />
            <button
              type="button"
              onClick={() => void logout()}
              className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-xs text-muted-foreground hover:bg-white/[0.05] hover:text-foreground"
            >
              Sign out
            </button>
          </DropdownContent>
        </Dropdown>
      </div>
    </header>
  );
}
