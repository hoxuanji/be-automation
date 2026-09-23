"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  LayoutGrid,
  Boxes,
  Rocket,
  Settings,
  FileCode2,
  Eye,
  LayoutTemplate,
  Images,
  FolderGit2,
  Code2,
  GitBranch,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Logo } from "@/components/shared/logo";
import { useStackStore } from "@/lib/store";

const groups = [
  {
    label: "Build",
    items: [
      { href: "/dashboard", label: "Dashboard", icon: LayoutGrid },
      { href: "/builder", label: "Builder", icon: Boxes },
      { href: "/api-builder", label: "API Builder", icon: FileCode2 },
      { href: "/preview", label: "Preview", icon: Eye },
      { href: "/editor", label: "Code editor", icon: Code2 },
    ],
  },
  {
    label: "Start from",
    items: [
      { href: "/templates", label: "Templates", icon: LayoutTemplate },
      { href: "/gallery", label: "Gallery", icon: Images },
      { href: "/from-repo", label: "Import repo", icon: FolderGit2 },
    ],
  },
  {
    label: "Ship",
    items: [
      { href: "/deploy", label: "Deploy", icon: Rocket },
      { href: "/git-settings", label: "Git settings", icon: GitBranch },
      { href: "/settings", label: "Settings", icon: Settings },
    ],
  },
];

export function Sidebar() {
  const pathname = usePathname();
  const { workspace } = useStackStore();

  return (
    <aside className="hidden lg:flex w-52 shrink-0 flex-col border-r border-white/[0.06] bg-background/60 backdrop-blur-sm">
      <div className="flex h-14 items-center px-4 border-b border-white/[0.06]">
        <Logo />
      </div>

      <nav className="flex-1 overflow-y-auto px-3 py-4 space-y-5">
        {groups.map((group) => (
          <div key={group.label}>
            <p className="px-2.5 pb-1.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground/60">
              {group.label}
            </p>
            <ul className="space-y-0.5">
              {group.items.map((item) => {
                const active =
                  pathname === item.href ||
                  (item.href !== "/" && pathname.startsWith(item.href));
                const Icon = item.icon;
                return (
                  <li key={item.href}>
                    <Link
                      href={item.href}
                      className={cn(
                        "flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm transition-colors",
                        active
                          ? "bg-white/[0.06] text-foreground"
                          : "text-muted-foreground hover:text-foreground hover:bg-white/[0.03]"
                      )}
                    >
                      <Icon className="h-[15px] w-[15px]" />
                      {item.label}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </nav>

      <div className="px-4 py-3 border-t border-white/[0.06]">
        <p className="text-xs text-muted-foreground truncate">{workspace}</p>
      </div>
    </aside>
  );
}
