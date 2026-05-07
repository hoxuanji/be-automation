import Link from "next/link";
import { cn } from "@/lib/utils";

export function Logo({
  className,
  compact = false,
}: {
  className?: string;
  compact?: boolean;
}) {
  return (
    <Link href="/" className={cn("flex items-center gap-2 group", className)}>
      <div className="relative">
        <div className="absolute inset-0 rounded-[10px] bg-brand-500/30 blur-md group-hover:bg-brand-500/50 transition-colors" />
        <div className="relative grid h-8 w-8 place-items-center rounded-[10px] bg-gradient-to-br from-brand-400 via-brand-500 to-purple-500 shadow-lg">
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            className="text-white"
          >
            <path
              d="M4 6l8-4 8 4v12l-8 4-8-4V6z"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinejoin="round"
            />
            <path
              d="M12 2v20M4 6l8 4 8-4M4 18l8-4 8 4"
              stroke="currentColor"
              strokeWidth="1.4"
              strokeLinejoin="round"
              opacity="0.7"
            />
          </svg>
        </div>
      </div>
      {!compact ? (
        <div className="flex flex-col leading-none">
          <span className="text-sm font-semibold tracking-tight">Helios</span>
          <span className="text-[10px] text-muted-foreground">
            infrastructure
          </span>
        </div>
      ) : null}
    </Link>
  );
}
