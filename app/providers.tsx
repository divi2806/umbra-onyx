"use client";

import "@/lib/buffer-polyfill";

import type { ReactNode } from "react";

import { FirstVisitWalkthrough } from "@/components/onboarding/first-visit-walkthrough";
import { UmbraClientProvider } from "@/lib/umbra/client";
import { SolanaProvider } from "@/lib/solana/providers";
import { TooltipProvider } from "@/components/ui/tooltip";

export function Providers({ children }: { children: ReactNode }) {
  return (
    <SolanaProvider>
      <UmbraClientProvider>
        <TooltipProvider>
          {children}
          <FirstVisitWalkthrough />
        </TooltipProvider>
      </UmbraClientProvider>
    </SolanaProvider>
  );
}
