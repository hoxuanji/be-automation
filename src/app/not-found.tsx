import Link from "next/link";
import { Logo } from "@/components/shared/logo";
import { Button } from "@/components/ui/button";

export default function NotFound() {
  return (
    <div className="min-h-screen bg-background flex flex-col items-center justify-center gap-6 text-center p-6">
      <div className="pointer-events-none fixed inset-0 -z-10">
        <div className="absolute inset-0 grid-bg mask-radial opacity-30" />
      </div>
      <Logo />
      <div className="space-y-2">
        <p className="text-6xl font-bold text-foreground/10 select-none">404</p>
        <h1 className="text-xl font-semibold">Page not found</h1>
        <p className="text-sm text-muted-foreground max-w-xs">
          This page doesn&apos;t exist or was moved.
        </p>
      </div>
      <Button asChild variant="secondary" size="sm">
        <Link href="/dashboard">Go to dashboard</Link>
      </Button>
    </div>
  );
}
