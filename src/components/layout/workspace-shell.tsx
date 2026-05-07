import { Sidebar } from "./sidebar";
import { Topbar } from "./topbar";

export function WorkspaceShell({
  children,
  breadcrumb,
  actions,
  right,
}: {
  children: React.ReactNode;
  breadcrumb?: { label: string; href?: string }[];
  actions?: React.ReactNode;
  right?: React.ReactNode;
}) {
  return (
    <div className="flex h-screen w-full overflow-hidden bg-background">
      <Sidebar />
      <div className="flex flex-1 flex-col min-w-0">
        <Topbar breadcrumb={breadcrumb} actions={actions} />
        <div className="flex flex-1 min-h-0">
          <main className="flex-1 overflow-y-auto">{children}</main>
          {right ? (
            <aside className="hidden xl:flex w-[320px] shrink-0 border-l border-white/[0.06] bg-background/60 backdrop-blur-sm">
              {right}
            </aside>
          ) : null}
        </div>
      </div>
    </div>
  );
}
