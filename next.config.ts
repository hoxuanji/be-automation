import type { NextConfig } from "next";

const IS_PROD = process.env.NODE_ENV === "production";

// Security headers applied to every response. CSP is intentionally omitted
// from this list — Next.js RSC payloads use inline scripts and a proper CSP
// requires a per-request nonce, which is a larger change. Until then, these
// headers cover the common footguns: clickjacking, MIME sniffing, referrer
// leaks, feature access, transport security.
const securityHeaders = [
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=(), browsing-topics=(), interest-cohort=()",
  },
  // HSTS only matters over HTTPS; emit only in production so dev on http://
  // localhost doesn't get persistently upgraded.
  ...(IS_PROD
    ? [{ key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" }]
    : []),
];

const nextConfig: NextConfig = {
  reactStrictMode: true,
  serverExternalPackages: ["better-sqlite3"],
  async headers() {
    return [
      {
        source: "/:path*",
        headers: securityHeaders,
      },
    ];
  },
};

export default nextConfig;
