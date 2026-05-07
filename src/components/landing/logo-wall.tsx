const logos = [
  "Vercel",
  "Railway",
  "Supabase",
  "Neon",
  "PlanetScale",
  "Upstash",
  "Cloudflare",
  "Stripe",
];

export function LogoWall() {
  return (
    <section className="py-10">
      <div className="container">
        <p className="text-center text-[11px] uppercase tracking-[0.25em] text-muted-foreground/70">
          Trusted by infrastructure teams at
        </p>
        <div className="mt-6 grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-8 gap-6 items-center justify-items-center">
          {logos.map((l) => (
            <div
              key={l}
              className="text-sm font-semibold tracking-tight text-muted-foreground/80 hover:text-foreground transition-colors"
            >
              {l}
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
