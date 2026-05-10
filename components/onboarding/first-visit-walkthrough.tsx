"use client";

import {
  ArrowRight01Icon,
  CheckmarkCircle01Icon,
  DollarSendIcon,
  FileSecurityIcon,
  InvoiceIcon,
  ShieldKeyIcon,
  Wallet01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import * as React from "react";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { FancyButton } from "@/components/ui/fancy-button";
import { cn } from "@/lib/utils";

const STORAGE_KEY = "onyx:first-visit-walkthrough:v1";

const STEPS = [
  {
    icon: ShieldKeyIcon,
    eyebrow: "Private payments",
    title: "Move money without exposing your operating graph.",
    body: "Onyx routes payroll, invoices, vendor payments, and treasury transfers through Umbra shielded UTXOs so public explorers do not show every counterparty and amount.",
  },
  {
    icon: Wallet01Icon,
    eyebrow: "First setup",
    title: "Pick a network, connect a wallet, then let Umbra register it.",
    body: "Use the Mainnet/Devnet selector in the header. When you connect a wallet for the first time, Onyx prepares the Umbra encrypted account required to receive shielded payments.",
  },
  {
    icon: DollarSendIcon,
    eyebrow: "Send and receive",
    title: "Send privately, scan received UTXOs, then claim.",
    body: "Use Send, Payroll, or Invoice to create receiver-claimable UTXOs. Recipients use Ledger to sync incoming UTXOs, claim them into encrypted balance, and withdraw to their wallet.",
  },
  {
    icon: FileSecurityIcon,
    eyebrow: "Audit access",
    title: "Share bounded records without making your ledger public.",
    body: "Generate an audit access key for a date range. Auditors paste the token into the Audit portal, review the scoped rows, and export a CSV. The key cannot spend or claim funds.",
  },
] as const;

function hasSeenWalkthrough(): boolean {
  try {
    return window.localStorage.getItem(STORAGE_KEY) === "seen";
  } catch {
    return true;
  }
}

function markWalkthroughSeen(): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, "seen");
  } catch {
    // Ignore blocked storage; the dialog can still be closed for this session.
  }
}

export function FirstVisitWalkthrough() {
  const [open, setOpen] = React.useState(false);
  const [index, setIndex] = React.useState(0);
  const step = STEPS[index];
  const isLast = index === STEPS.length - 1;

  React.useEffect(() => {
    if (!hasSeenWalkthrough()) {
      const id = window.setTimeout(() => setOpen(true), 350);
      return () => window.clearTimeout(id);
    }
  }, []);

  function closeAndRemember() {
    markWalkthroughSeen();
    setOpen(false);
  }

  function handleOpenChange(nextOpen: boolean) {
    if (!nextOpen) {
      closeAndRemember();
      return;
    }
    setOpen(true);
  }

  function nextStep() {
    if (isLast) {
      closeAndRemember();
      return;
    }
    setIndex((current) => current + 1);
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="gap-5 overflow-hidden p-0 sm:max-w-[520px]">
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-0 top-0 h-24 bg-gradient-to-b from-primary/12 to-transparent"
        />

        <div className="relative p-6 pb-0 sm:p-7 sm:pb-0">
          <div className="mb-5 flex items-center justify-between gap-4 pr-10">
            <div className="inline-flex items-center gap-2 rounded-full border border-primary/20 bg-primary/8 px-3 py-1 text-[10.5px] font-semibold uppercase tracking-[0.16em] text-primary/80">
              <span className="size-1.5 rounded-full bg-primary/70" />
              Onyx walkthrough
            </div>
            <span className="font-mono text-[11px] text-muted-foreground">
              {index + 1}/{STEPS.length}
            </span>
          </div>

          <DialogHeader className="gap-3">
            <div className="grid size-11 place-items-center rounded-xl border border-primary/20 bg-primary/10 text-primary">
              <HugeiconsIcon icon={step.icon} size={20} strokeWidth={1.7} />
            </div>
            <div>
              <p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-primary/75">
                {step.eyebrow}
              </p>
              <DialogTitle className="max-w-[430px] text-[21px] font-semibold leading-[1.08] tracking-[-0.03em] text-foreground sm:text-[24px]">
                {step.title}
              </DialogTitle>
              <DialogDescription className="mt-3 max-w-[440px] text-[13.5px] leading-6">
                {step.body}
              </DialogDescription>
            </div>
          </DialogHeader>

          <div className="mt-6 grid gap-2 sm:grid-cols-2">
            {[
              { label: "Mainnet or Devnet", value: "Selectable" },
              { label: "Wallet custody", value: "Non-custodial" },
              { label: "Privacy layer", value: "Umbra SDK" },
              { label: "Audit review", value: "Read-only token" },
            ].map((item) => (
              <div
                key={item.label}
                className="rounded-xl border border-border/60 bg-background/45 px-3 py-2.5"
              >
                <p className="text-[11px] text-muted-foreground">{item.label}</p>
                <p className="mt-0.5 flex items-center gap-1.5 text-[12.5px] font-medium text-foreground">
                  <HugeiconsIcon
                    icon={CheckmarkCircle01Icon}
                    size={13}
                    strokeWidth={2}
                    className="text-primary"
                  />
                  {item.value}
                </p>
              </div>
            ))}
          </div>
        </div>

        <div className="px-6 sm:px-7">
          <div className="flex items-center gap-1.5">
            {STEPS.map((item, i) => (
              <button
                key={item.eyebrow}
                type="button"
                aria-label={`Go to walkthrough step ${i + 1}`}
                onClick={() => setIndex(i)}
                className="group grid h-10 flex-1 place-items-center rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
              >
                <span
                  className={cn(
                    "h-1.5 w-full rounded-full transition-colors",
                    i === index ? "bg-primary" : "bg-border group-hover:bg-border/80",
                  )}
                />
              </button>
            ))}
          </div>
        </div>

        <DialogFooter className="border-t border-border/60 bg-background/35 p-4 sm:flex-row sm:items-center sm:justify-between">
          <button
            type="button"
            onClick={closeAndRemember}
            className="inline-flex h-10 items-center justify-center rounded-xl px-4 text-[13px] font-medium text-muted-foreground transition-colors hover:bg-secondary/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
          >
            Skip
          </button>
          <FancyButton type="button" size="lg" onClick={nextStep}>
            {isLast ? "Start using Onyx" : "Next"}
            <HugeiconsIcon
              icon={isLast ? InvoiceIcon : ArrowRight01Icon}
              size={14}
              strokeWidth={2.2}
            />
          </FancyButton>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
