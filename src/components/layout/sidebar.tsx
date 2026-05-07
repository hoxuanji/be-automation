"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  LayoutGrid,
  Boxes,
  Network,
  FolderGit2,
  Rocket,
  BookOpen,
  Settings,
  Sparkles,
  HelpCircle,
  Users,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Logo } from "@/components/shared/logo";
import { Badge } from "@/components/ui/badge";
import {
  Dropdown,
  DropdownContent,
  DropdownItem,
  DropdownLabel,
  DropdownSeparator,
  DropdownTrigger,
} from "@/components/ui/dropdown";
import { useStackStore } from "@/lib/store";
import { toast } from "@/components/ui/toast";

const nav = [
  { href: "/dashboard", label: "Dashboard", icon: LayoutGrid },
  { href: "/builder", label: "Stack Builder", icon: Boxes, badge: "AI" },
  { href: "/api-builder", label: "API Contracts", icon: Network },
  { href: "/preview", label: "Repository", icon: FolderGit2 },
  { href: "/deploy", label: "Deploy", icon: Rocket },
];

const secondary = [
  { label: "Templates", icon: BookOpen, action: "templates" as const },
  { label: "Team", icon: Users, action: "team" as const },
  { label: "Settings", icon: Settings, action: "settings" as const },
];

export function Sidebar() {
  const pathname = usePathname();
  const { workspace, workspaces, setWorkspace } = useStackStore();
  const initials = workspace
    .split(/\s+/)
    .map((p) => p[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
  return (
    <aside className="hidden lg:flex w-60 shrink-0 flex-col border-r border-white/[0.06] bg-background/60 backdrop-blur-sm">
      <div className="flex h-14 items-center px-4 border-b border-white/[0.06]">
        <Logo />
      </div>

      <div className="px-3 py-4">
        <div className="flex items-center justify-between px-2 pb-2">
          <span className="text-[10px] font-medium uppercase tracking-widest text-muted-foreground/70">
            Workspace
          </span>
          <Badge variant="outline" className="text-[9px]">
            Pro
          </Badge>
        </div>
        <Dropdown className="block w-full">
          <DropdownTrigger>
            <button
              type="button"
              className="w-full flex items-center justify-between gap-2 rounded-lg border border-white/10 bg-white/[0.02] px-2.5 py-2 text-left text-sm hover:bg-white/[0.04] transition-colors"
            >
              <div className="flex items-center gap-2">
                <div className="h-6 w-6 rounded-md bg-gradient-to-br from-brand-500 to-purple-500 grid place-items-center text-[10px] font-semibold">
                  {initials}
                </div>
                <div className="leading-tight">
                  <div className="text-xs font-medium">{workspace}</div>
                  <div className="text-[10px] text-muted-foreground">
                    12 projects
                  </div>
                </div>
              </div>
              <svg
                width="12"
                height="12"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                className="text-muted-foreground"
              >
                <path d="M8 9l4-4 4 4M8 15l4 4 4-4" />
              </svg>
            </button>
          </DropdownTrigger>
          <DropdownContent className="w-[calc(100%-0px)] min-w-[210px]">
            <DropdownLabel>Switch workspace</DropdownLabel>
            {workspaces.map((w) => (
              <DropdownItem
                key={w}
                onSelect={() => setWorkspace(w)}
                className={
                  workspace === w ? "bg-white/[0.04] text-foreground" : undefined
                }
              >
                <span className="h-5 w-5 rounded-md bg-gradient-to-br from-brand-500 to-purple-500 grid place-items-center text-[9px] font-semibold text-white">
                  {w
                    .split(/\s+/)
                    .map((p) => p[0])
                    .join("")
                    .slice(0, 2)
                    .toUpperCase()}
                </span>
                {w}
                {workspace === w ? (
                  <span className="ml-auto text-[10px] text-brand-300">
                    current
                  </span>
                ) : null}
              </DropdownItem>
            ))}
            <DropdownSeparator />
            <DropdownItem onSelect={() => {}}>
              + Create workspace
            </DropdownItem>
          </DropdownContent>
        </Dropdown>
      </div>

      <nav className="flex-1 overflow-y-auto px-3 pb-4">
        <ul className="space-y-0.5">
          {nav.map((item) => {
            const active =
              pathname === item.href ||
              (item.href !== "/" && pathname.startsWith(item.href));
            const Icon = item.icon;
            return (
              <li key={item.href}>
                <Link
                  href={item.href}
                  className={cn(
                    "group flex items-center justify-between rounded-lg px-2.5 py-2 text-sm transition-colors",
                    active
                      ? "bg-white/[0.06] text-foreground"
                      : "text-muted-foreground hover:text-foreground hover:bg-white/[0.03]"
                  )}
                >
                  <span className="flex items-center gap-2.5">
                    <Icon className="h-[15px] w-[15px]" />
                    {item.label}
                  </span>
                  {item.badge ? (
                    <span className="inline-flex items-center gap-0.5 rounded-full border border-brand-500/30 bg-brand-500/10 px-1.5 py-0.5 text-[9px] font-medium text-brand-300">
                      <Sparkles className="h-2.5 w-2.5" />
                      {item.badge}
                    </span>
                  ) : null}
                </Link>
              </li>
            );
          })}
        </ul>

        <div className="pt-6 pb-2 px-2">
          <span className="text-[10px] font-medium uppercase tracking-widest text-muted-foreground/70">
            Resources
          </span>
        </div>
        <ul className="space-y-0.5">
          {secondary.map((item) => {
            const Icon = item.icon;
            return (
              <li key={item.label}>
                <button
                  type="button"
                  onClick={() =>
                    toast({
                      title: item.label,
                      description:
                        item.action === "templates"
                          ? "Browse production templates from the Dashboard."
                          : item.action === "team"
                          ? "Invite teammates — coming soon."
                          : "Workspace settings — coming soon.",
                      kind: "info",
                    })
                  }
                  className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm text-muted-foreground hover:text-foreground hover:bg-white/[0.03] transition-colors"
                >
                  <Icon className="h-[15px] w-[15px]" />
                  {item.label}
                </button>
              </li>
            );
          })}
        </ul>
      </nav>

      <div className="m-3 rounded-xl border border-white/[0.06] bg-gradient-to-b from-brand-500/[0.08] to-transparent p-3">
        <div className="flex items-center gap-2">
          <div className="h-6 w-6 rounded-md bg-brand-500/20 grid place-items-center">
            <Sparkles className="h-3 w-3 text-brand-300" />
          </div>
          <span className="text-xs font-semibold">AI Credits</span>
        </div>
        <div className="mt-2 flex items-baseline gap-1">
          <span className="text-lg font-semibold">4,210</span>
          <span className="text-[10px] text-muted-foreground">/ 10,000</span>
        </div>
        <div className="mt-2 h-1 overflow-hidden rounded-full bg-white/[0.06]">
          <div className="h-full w-[42%] rounded-full bg-gradient-to-r from-brand-400 to-purple-400" />
        </div>
        <button
          type="button"
          onClick={() =>
            toast({
              title: "Upgrade to Helios Scale",
              description: "Unlimited generations, private workspaces, priority AI.",
              kind: "info",
            })
          }
          className="mt-3 w-full text-xs inline-flex items-center justify-center gap-1 rounded-md border border-white/10 bg-white/[0.03] py-1.5 hover:bg-white/[0.06] transition-colors"
        >
          <HelpCircle className="h-3 w-3" />
          Upgrade plan
        </button>
      </div>
    </aside>
  );
}
