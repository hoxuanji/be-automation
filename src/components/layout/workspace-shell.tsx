import { Sidebar } from "./sidebar";
import { Topbar } from "./topbar";
import { FloatingAI } from "@/components/shared/floating-ai";

export function WorkspaceShell({
  children,
  breadcrumb,
  actions,
}: {
  children: React.ReactNode;
  breadcrumb?: { label: string; href?: string }[];
  actions?: React.ReactNode;
}) {
  return (
    <div className="flex h-screen w-full overflow-hidden bg-background">
      <Sidebar />
      <div className="flex flex-1 flex-col min-w-0">
        <Topbar breadcrumb={breadcrumb} actions={actions} />
        <main className="flex-1 overflow-y-auto">{children}</main>
      </div>
      <FloatingAI />
    </div>
  );
}
