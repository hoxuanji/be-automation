export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen flex items-center justify-center bg-background dot-bg">
      <div className="w-full max-w-sm px-4 py-12">{children}</div>
    </div>
  );
}
