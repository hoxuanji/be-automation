"use client";

import * as React from "react";
import { useStackStore } from "@/lib/store";

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const loadAuth = useStackStore((s) => s.loadAuth);

  React.useEffect(() => {
    void loadAuth();
  }, [loadAuth]);

  return <>{children}</>;
}
