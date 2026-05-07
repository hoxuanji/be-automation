import type { Metadata } from "next";
import "./globals.css";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Toaster } from "@/components/ui/toast";

export const metadata: Metadata = {
  title: "Helios — Infrastructure Generator",
  description:
    "Visually configure and generate production-ready backend repositories. Vercel × Railway × Cursor × Terraform, reimagined as an AI-native platform.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className="dark">
      <head>
        <link
          rel="preconnect"
          href="https://fonts.googleapis.com"
          crossOrigin=""
        />
        <link
          href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600&display=swap"
          rel="stylesheet"
        />
      </head>
      <body className="font-sans">
        <TooltipProvider delayDuration={80}>
          <div className="relative min-h-screen">{children}</div>
          <Toaster />
        </TooltipProvider>
      </body>
    </html>
  );
}
