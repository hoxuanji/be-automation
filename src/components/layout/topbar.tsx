"use client";

import { useRouter } from "next/navigation";
import { Search, Bell, GitBranch, Play, Sparkles, AlertCircle, Check } from "lucide-react";
import { Kbd } from "@/components/ui/kbd";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Dropdown,
  DropdownContent,
  DropdownLabel,
  DropdownSeparator,
  DropdownTrigger,
} from "@/components/ui/dropdown";
import { toast } from "@/components/ui/toast";
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
  const router = useRouter();
  const { config, authUser, logout } = useStackStore();

  const initials = authUser
    ? authUser.name
        .split(/\s+/)
        .map((p) => p[0])
        .join("")
        .slice(0, 2)
        .toUpperCase()
    : "??";

  function onGenerate() {
    toast({
      title: "Opening repository preview",
      description: `Preparing ${config.name}…`,
      kind: "info",
    });
    router.push("/preview");
  }

  function onSearchSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const data = new FormData(e.currentTarget);
    const q = String(data.get("q") ?? "").trim();
    if (!q) return;
    toast({ title: "Search", description: `No matches for "${q}" yet.`, kind: "info" });
  }

  return (
    <header className="sticky top-0 z-30 flex h-14 items-center justify-between gap-4 border-b border-white/[0.06] bg-background/70 px-5 backdrop-blur-md">
      <div className="flex items-center gap-4 min-w-0">
        {breadcrumb ? (
          <nav className="flex items-center gap-1.5 text-xs text-muted-foreground min-w-0">
            {breadcrumb.map((b, i) => (
              <span key={i} className="flex items-center gap-1.5 min-w-0">
                {i > 0 ? <span className="text-white/20">/</span> : null}
                {b.href ? (
                  <a
                    href={b.href}
                    className="truncate hover:text-foreground transition-colors"
                  >
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

        <div className="hidden md:flex items-center gap-1 rounded-md border border-white/[0.06] bg-white/[0.02] px-2 py-1 text-[11px] text-muted-foreground">
          <GitBranch className="h-3 w-3" />
          <span>main</span>
          <span className="text-white/20">·</span>
          <span className="text-emerald-300">synced</span>
        </div>
      </div>

      <div className="flex items-center gap-3">
        <form
          onSubmit={onSearchSubmit}
          className="hidden md:flex items-center gap-2 rounded-md border border-white/[0.06] bg-white/[0.02] px-2.5 py-1.5 w-72 focus-within:border-brand-500/30 transition-colors"
        >
          <Search className="h-3.5 w-3.5 text-muted-foreground" />
          <input
            name="q"
            className="flex-1 bg-transparent text-xs placeholder:text-muted-foreground/70 focus:outline-none"
            placeholder="Search stacks, endpoints, docs…"
          />
          <Kbd>⌘K</Kbd>
        </form>

        <NotificationsMenu />

        {actions}

        <Button variant="glow" size="sm" onClick={onGenerate}>
          <Play className="h-3.5 w-3.5" />
          Generate
        </Button>

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
              href="/dashboard"
              className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-xs text-muted-foreground hover:bg-white/[0.05] hover:text-foreground"
            >
              Dashboard
            </a>
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

function NotificationsMenu() {
  const items = [
    {
      icon: Sparkles,
      title: "New AI recommendation",
      desc: "Enable distributed tracing on helios-api.",
      time: "2m",
      tone: "brand",
    },
    {
      icon: Check,
      title: "Deployment succeeded",
      desc: "ledger-svc · us-east-1",
      time: "38m",
      tone: "emerald",
    },
    {
      icon: AlertCircle,
      title: "Budget alert",
      desc: "notifier is tracking 18% above budget this cycle.",
      time: "2h",
      tone: "amber",
    },
  ];
  const toneMap: Record<string, string> = {
    brand: "text-brand-300 border-brand-500/30 bg-brand-500/10",
    emerald: "text-emerald-300 border-emerald-500/30 bg-emerald-500/10",
    amber: "text-amber-300 border-amber-500/30 bg-amber-500/10",
  };
  return (
    <Dropdown>
      <DropdownTrigger>
        <Button variant="ghost" size="icon" className="relative" aria-label="Notifications">
          <Bell className="h-4 w-4" />
          <span className="absolute top-1.5 right-1.5 h-1.5 w-1.5 rounded-full bg-brand-400" />
        </Button>
      </DropdownTrigger>
      <DropdownContent align="end" className="w-[320px]">
        <div className="flex items-center justify-between px-2.5 pt-2 pb-1">
          <span className="text-[10px] uppercase tracking-widest text-muted-foreground/70">
            Notifications
          </span>
          <Badge variant="brand">{items.length}</Badge>
        </div>
        <DropdownSeparator />
        {items.map((it, i) => {
          const Icon = it.icon;
          return (
            <button
              key={i}
              type="button"
              onClick={() =>
                toast({ title: it.title, description: it.desc, kind: "info" })
              }
              className="flex w-full items-start gap-2 rounded-md px-2.5 py-2 text-left hover:bg-white/[0.05]"
            >
              <div
                className={`grid h-6 w-6 shrink-0 place-items-center rounded-md border ${toneMap[it.tone]}`}
              >
                <Icon className="h-3 w-3" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="text-xs font-medium">{it.title}</div>
                <div className="text-[11px] text-muted-foreground line-clamp-2">
                  {it.desc}
                </div>
              </div>
              <span className="shrink-0 text-[10px] text-muted-foreground">
                {it.time}
              </span>
            </button>
          );
        })}
        <DropdownSeparator />
        <button
          type="button"
          onClick={() => toast({ title: "Marked all as read", kind: "success" })}
          className="flex w-full items-center justify-center gap-1 rounded-md px-2.5 py-1.5 text-[11px] text-muted-foreground hover:text-foreground hover:bg-white/[0.05]"
        >
          Mark all as read
        </button>
      </DropdownContent>
    </Dropdown>
  );
}

export function TopbarStatusPill({
  label,
  tone = "default",
}: {
  label: string;
  tone?: "default" | "success" | "warning";
}) {
  const map = {
    default: "text-muted-foreground",
    success: "text-emerald-300",
    warning: "text-amber-300",
  };
  return (
    <Badge variant="outline" className={map[tone]}>
      <span className="h-1.5 w-1.5 rounded-full bg-current" />
      {label}
    </Badge>
  );
}
