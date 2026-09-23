"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * Brand registry: inline SVG paths for the most-visible tech logos, plus a
 * monogram fallback for anything else. All SVGs are 24x24 viewBox, single
 * path, rendered in `currentColor` so they pick up text color from the
 * parent.
 */

type BrandMeta = {
  name: string;
  accent: string;
  // If supplied, a monochrome SVG path rendered in `currentColor`. Otherwise
  // the component falls back to a gradient monogram chip.
  path?: string;
  // Some marks have secondary paths rendered behind the main one.
  bgPath?: string;
  // Override viewBox (default 24x24).
  viewBox?: string;
  // Text initials if we want to override auto-derivation.
  initials?: string;
  // Whether the foreground should be rendered in white on the accent
  // background instead of pure currentColor.
  onAccent?: boolean;
};

const BRANDS: Record<string, BrandMeta> = {
  // Languages ------------------------------------------------------------
  go: {
    name: "Go",
    accent: "#00ADD8",
    initials: "Go",
    onAccent: true,
  },
  typescript: {
    name: "TypeScript",
    accent: "#3178C6",
    initials: "TS",
    onAccent: true,
  },
  python: {
    name: "Python",
    accent: "#3776AB",
    initials: "Py",
    onAccent: true,
  },
  rust: {
    name: "Rust",
    accent: "#DEA584",
    initials: "Rs",
    onAccent: true,
  },
  java: {
    name: "Java",
    accent: "#F89820",
    initials: "Jv",
    onAccent: true,
  },
  kotlin: {
    name: "Kotlin",
    accent: "#7F52FF",
    initials: "Kt",
    onAccent: true,
  },

  // Databases ------------------------------------------------------------
  postgres: {
    name: "PostgreSQL",
    accent: "#336791",
    path:
      // stylised elephant head (simplified)
      "M12 2c-4 0-7 2.4-7 6v3.2c0 .9.1 1.8.4 2.6.6 1.8 1.9 3.4 3.7 4.3.5.3 1 .5 1.5.6v2.9c0 .8.6 1.4 1.4 1.4s1.4-.6 1.4-1.4v-2.9c.5-.1 1-.3 1.5-.6 1.8-.9 3.1-2.5 3.7-4.3.3-.8.4-1.7.4-2.6V8c0-3.6-3-6-7-6Zm-2.5 6.5a1.25 1.25 0 1 1 0 2.5 1.25 1.25 0 0 1 0-2.5Zm5 0a1.25 1.25 0 1 1 0 2.5 1.25 1.25 0 0 1 0-2.5Z",
  },
  mysql: {
    name: "MySQL",
    accent: "#00758F",
    initials: "My",
    onAccent: true,
  },
  mongodb: {
    name: "MongoDB",
    accent: "#47A248",
    path:
      // leaf shape
      "M12 2c-2 3-5 5-5 9 0 4 3 7 5 11 2-4 5-7 5-11 0-4-3-6-5-9Zm0 4c1 2 3 3 3 6 0 3-2 4-3 6-1-2-3-3-3-6 0-3 2-4 3-6Z",
  },
  dynamodb: {
    name: "DynamoDB",
    accent: "#4053D6",
    initials: "Dy",
    onAccent: true,
  },
  cockroach: {
    name: "CockroachDB",
    accent: "#6933FF",
    initials: "Cr",
    onAccent: true,
  },
  planetscale: {
    name: "PlanetScale",
    accent: "#F4F4F5",
    initials: "PS",
  },
  supabase: {
    name: "Supabase",
    accent: "#3ECF8E",
    path:
      // downward lightning / wedge
      "M13 2 4 13h7l-2 9 11-13h-7l3-7h-3Z",
  },
  neon: {
    name: "Neon",
    accent: "#00E599",
    initials: "Nn",
    onAccent: true,
  },

  // Caches ---------------------------------------------------------------
  redis: {
    name: "Redis",
    accent: "#DC382D",
    path:
      // stacked cube
      "M12 2 3 6.5l9 4.5 9-4.5L12 2Zm0 9L3 6.5v3L12 14l9-4.5v-3L12 11Zm0 3L3 9.5v3L12 17l9-4.5v-3L12 14Zm0 3L3 12.5v3L12 20l9-4.5v-3L12 17Z",
  },
  memcached: {
    name: "Memcached",
    accent: "#006848",
    initials: "Mc",
    onAccent: true,
  },
  dragonfly: {
    name: "Dragonfly",
    accent: "#F48FB1",
    initials: "Df",
    onAccent: true,
  },
  upstash: {
    name: "Upstash",
    accent: "#00E599",
    initials: "Up",
    onAccent: true,
  },

  // Queues ---------------------------------------------------------------
  rabbitmq: {
    name: "RabbitMQ",
    accent: "#FF6600",
    initials: "Rm",
    onAccent: true,
  },
  kafka: {
    name: "Apache Kafka",
    accent: "#231F20",
    path:
      // three connected nodes
      "M6 4a2 2 0 1 1 0 4 2 2 0 0 1 0-4Zm12 0a2 2 0 1 1 0 4 2 2 0 0 1 0-4Zm-6 7a2 2 0 1 1 0 4 2 2 0 0 1 0-4Zm-6 7a2 2 0 1 1 0 4 2 2 0 0 1 0-4Zm12 0a2 2 0 1 1 0 4 2 2 0 0 1 0-4ZM7.5 8.5l3 2m3 0 3-2M7.5 15.5l3-2m3 0 3 2",
  },
  sqs: {
    name: "AWS SQS",
    accent: "#FF9900",
    initials: "SQ",
    onAccent: true,
  },
  nats: {
    name: "NATS",
    accent: "#27AAE1",
    initials: "Na",
    onAccent: true,
  },
  bullmq: {
    name: "BullMQ",
    accent: "#DC382D",
    initials: "Bq",
    onAccent: true,
  },

  // Auth -----------------------------------------------------------------
  clerk: {
    name: "Clerk",
    accent: "#6C47FF",
    initials: "Ck",
    onAccent: true,
  },
  auth0: {
    name: "Auth0",
    accent: "#EB5424",
    initials: "A0",
    onAccent: true,
  },
  "supabase-auth": {
    name: "Supabase Auth",
    accent: "#3ECF8E",
    initials: "Sb",
    onAccent: true,
  },
  cognito: {
    name: "AWS Cognito",
    accent: "#DD344C",
    initials: "Cg",
    onAccent: true,
  },
  firebase: {
    name: "Firebase",
    accent: "#FFCA28",
    initials: "Fb",
  },
  keycloak: {
    name: "Keycloak",
    accent: "#4D4D4D",
    initials: "Kc",
    onAccent: true,
  },

  // Deployment ----------------------------------------------------------
  vercel: {
    name: "Vercel",
    accent: "#FFFFFF",
    // downward triangle Vercel mark
    path: "M12 2 22 20H2Z",
  },
  railway: {
    name: "Railway",
    accent: "#A855F7",
    path:
      // stacked rails
      "M4 6h16v3H4Zm0 4h16v3H4Zm0 4h10v3H4Z",
  },
  render: {
    name: "Render",
    accent: "#46E3B7",
    initials: "Rd",
    onAccent: true,
  },
  fly: {
    name: "Fly.io",
    accent: "#8B5CF6",
    path:
      // balloon-like mark
      "M6 10c0-3 2.7-5 6-5s6 2 6 5-2.7 6-6 6-6-3-6-6Zm6 6 2 5h-4l2-5Z",
  },
  bitbucket: {
    name: "Bitbucket",
    accent: "#2684FF",
    initials: "Bb",
    onAccent: true,
  },
  aws: {
    name: "AWS",
    accent: "#FF9900",
    path:
      // AWS smile arrow
      "M5 14a9 9 0 0 0 14 0 9 9 0 0 1-14 0Zm12-6 3 3-3 3v-2h-3V8h3Z",
  },
  gcp: {
    name: "Google Cloud",
    accent: "#4285F4",
    path:
      // cloud shape
      "M16 9a5 5 0 0 0-10 1H5a4 4 0 0 0 0 8h13a4 4 0 0 0 0-8h-2Z",
  },
  azure: {
    name: "Azure",
    accent: "#0078D4",
    path:
      // azure A
      "M11 3 4 21h6l1-3h4l-2-6-2 5-1-3 3-11h-2Z",
  },
  k8s: {
    name: "Kubernetes",
    accent: "#326CE5",
    path:
      // heptagon helm wheel
      "M12 2 3 7v10l9 5 9-5V7l-9-5Zm0 4a6 6 0 1 1 0 12 6 6 0 0 1 0-12Zm0 2v4l3 3-1.4 1.4L11 13V8h1Z",
  },

  // Monitoring / CI ------------------------------------------------------
  grafana: { name: "Grafana", accent: "#F46800", initials: "Gf", onAccent: true },
  datadog: { name: "Datadog", accent: "#632CA6", initials: "Dd", onAccent: true },
  sentry: { name: "Sentry", accent: "#362D59", initials: "Se", onAccent: true },
  newrelic: { name: "New Relic", accent: "#008C99", initials: "NR", onAccent: true },
  otel: { name: "OpenTelemetry", accent: "#F5A800", initials: "Ot", onAccent: true },
  "gh-actions": { name: "GitHub Actions", accent: "#2088FF", initials: "GH", onAccent: true },
  "gitlab-ci": { name: "GitLab CI", accent: "#FC6D26", initials: "GL", onAccent: true },
  circleci: { name: "CircleCI", accent: "#343434", initials: "CC", onAccent: true },
  argo: { name: "Argo", accent: "#EF7B4D", initials: "Ag", onAccent: true },
};

function inferInitials(id: string, meta?: BrandMeta) {
  if (meta?.initials) return meta.initials;
  if (meta?.name)
    return meta.name
      .replace(/[^A-Za-z0-9 ]+/g, " ")
      .split(/\s+/)
      .filter(Boolean)
      .map((p) => p[0])
      .slice(0, 2)
      .join("")
      .toUpperCase();
  return id.slice(0, 2).toUpperCase();
}

export function BrandIcon({
  id,
  size = 20,
  className,
  rounded = "md",
}: {
  id: string;
  size?: number;
  className?: string;
  rounded?: "sm" | "md" | "lg" | "full";
}) {
  const meta = BRANDS[id];
  const radii: Record<string, string> = {
    sm: "rounded",
    md: "rounded-md",
    lg: "rounded-lg",
    full: "rounded-full",
  };

  if (meta?.path) {
    // Inline SVG mark on a tinted background tile.
    return (
      <span
        className={cn(
          "inline-flex shrink-0 items-center justify-center",
          radii[rounded],
          className
        )}
        style={{
          width: size,
          height: size,
          background: `linear-gradient(135deg, ${meta.accent}22, ${meta.accent}08)`,
          boxShadow: `inset 0 0 0 1px ${meta.accent}33`,
          color: meta.accent,
        }}
        aria-label={meta.name}
        title={meta.name}
      >
        <svg
          viewBox={meta.viewBox ?? "0 0 24 24"}
          width={size * 0.65}
          height={size * 0.65}
          fill="currentColor"
          aria-hidden="true"
        >
          {meta.bgPath ? (
            <path d={meta.bgPath} opacity="0.4" />
          ) : null}
          <path d={meta.path} />
        </svg>
      </span>
    );
  }

  // Monogram fallback — gradient chip, 1–2 letters.
  const initials = inferInitials(id, meta);
  const accent = meta?.accent ?? "#8da3c6";
  const onAccent = meta?.onAccent ?? true;
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center justify-center font-semibold",
        radii[rounded],
        className
      )}
      style={{
        width: size,
        height: size,
        background: onAccent
          ? `linear-gradient(135deg, ${accent}, ${shade(accent, -0.18)})`
          : `linear-gradient(135deg, ${accent}22, ${accent}08)`,
        boxShadow: onAccent
          ? `inset 0 0 0 1px ${shade(accent, 0.18)}55`
          : `inset 0 0 0 1px ${accent}44`,
        color: onAccent ? pickFg(accent) : accent,
        fontSize: Math.max(9, Math.round(size * 0.42)),
        letterSpacing: "0.01em",
      }}
      aria-label={meta?.name ?? id}
      title={meta?.name ?? id}
    >
      {initials}
    </span>
  );
}

export function brandMeta(id: string) {
  return BRANDS[id];
}

// ------------- tiny color helpers (no external deps) ---------------

function hexToRgb(hex: string) {
  const h = hex.replace("#", "");
  const n = parseInt(
    h.length === 3
      ? h
          .split("")
          .map((c) => c + c)
          .join("")
      : h,
    16
  );
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

function rgbToHex(r: number, g: number, b: number) {
  const h = (x: number) => Math.max(0, Math.min(255, Math.round(x))).toString(16).padStart(2, "0");
  return `#${h(r)}${h(g)}${h(b)}`;
}

function shade(hex: string, amount: number) {
  const { r, g, b } = hexToRgb(hex);
  const t = amount > 0 ? 255 : 0;
  const p = Math.abs(amount);
  return rgbToHex(r + (t - r) * p, g + (t - g) * p, b + (t - b) * p);
}

function pickFg(hex: string) {
  const { r, g, b } = hexToRgb(hex);
  const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return lum > 0.65 ? "#0b1220" : "#ffffff";
}
