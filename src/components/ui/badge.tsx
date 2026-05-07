import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const badgeVariants = cva(
  "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium transition-colors",
  {
    variants: {
      variant: {
        default:
          "border-white/10 bg-white/[0.04] text-muted-foreground",
        solid:
          "border-transparent bg-white text-black",
        brand:
          "border-brand-500/20 bg-brand-500/10 text-brand-300",
        success:
          "border-emerald-500/20 bg-emerald-500/10 text-emerald-300",
        warning:
          "border-amber-500/20 bg-amber-500/10 text-amber-300",
        danger:
          "border-red-500/20 bg-red-500/10 text-red-300",
        purple:
          "border-purple-500/20 bg-purple-500/10 text-purple-300",
        outline:
          "border-white/10 bg-transparent text-muted-foreground",
      },
    },
    defaultVariants: { variant: "default" },
  }
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof badgeVariants> {}

export function Badge({ className, variant, ...props }: BadgeProps) {
  return (
    <div className={cn(badgeVariants({ variant }), className)} {...props} />
  );
}
