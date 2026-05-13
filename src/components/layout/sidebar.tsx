"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  LayoutGrid,
  Boxes,
  Rocket,
  Settings,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Logo } from "@/components/shared/logo";
import { useStackStore } from "@/lib/store";

const nav = [
  { href: "/dashboard", label: "Dashboard", icon: LayoutGrid },
  { href: "/builder", label: "Builder", icon: Boxes },
  { href: "/deploy", label: "Deploy", icon: Rocket },
  { href: "/settings", label: "Settings", icon: Settings },
];

export function Sidebar() {
  const pathname = usePathname();
  const { workspace } = useStackStore();

  return (
    <aside className="hidden lg:flex w-52 shrink-0 flex-col border-r border-white/[0.06] bg-background/60 backdrop-blur-sm">
      <div className="flex h-14 items-center px-4 border-b border-white/[0.06]">
        <Logo />
      </div>

      <nav className="flex-1 px-3 py-4">
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
      </nav>

      <div className="px-4 py-3 border-t border-white/[0.06]">
        <p className="text-xs text-muted-foreground truncate">{workspace}</p>
      </div>
    </aside>
  );
}
