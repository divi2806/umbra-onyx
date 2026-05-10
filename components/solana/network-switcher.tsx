"use client";

import {
  CheckmarkCircle01Icon,
  GlobalRefreshIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  getSolanaClusterLabel,
  setSolanaClusterOverride,
  solanaConfig,
  SWITCHABLE_SOLANA_CLUSTERS,
  type SwitchableSolanaCluster,
} from "@/lib/solana/config";
import { cn } from "@/lib/utils";

const DOT: Record<SwitchableSolanaCluster, string> = {
  "mainnet-beta": "bg-emerald-400",
  devnet: "bg-primary",
};

export function NetworkSwitcher({ className }: { className?: string }) {
  function selectCluster(cluster: SwitchableSolanaCluster) {
    if (cluster === solanaConfig.cluster) return;
    setSolanaClusterOverride(cluster);

    const nextUrl = new URL(window.location.href);
    nextUrl.searchParams.delete("_rsc");
    window.location.assign(nextUrl.toString());
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            type="button"
            variant="outline"
            size="sm"
            className={cn("gap-2 px-3", className)}
          />
        }
      >
        <HugeiconsIcon icon={GlobalRefreshIcon} size={14} strokeWidth={1.8} />
        <span className="inline-flex items-center gap-1.5">
          <span
            aria-hidden="true"
            className={cn(
              "size-1.5 rounded-full",
              solanaConfig.cluster === "mainnet-beta"
                ? DOT["mainnet-beta"]
                : DOT.devnet,
            )}
          />
          {solanaConfig.clusterLabel}
        </span>
      </DropdownMenuTrigger>

      <DropdownMenuContent align="end" sideOffset={8} className="min-w-56">
        <DropdownMenuLabel>Network</DropdownMenuLabel>
        {SWITCHABLE_SOLANA_CLUSTERS.map((cluster) => {
          const active = cluster === solanaConfig.cluster;
          return (
            <DropdownMenuItem
              key={cluster}
              onClick={() => selectCluster(cluster)}
              className="justify-between"
            >
              <span className="flex items-center gap-2">
                <span
                  aria-hidden="true"
                  className={cn("size-1.5 rounded-full", DOT[cluster])}
                />
                {getSolanaClusterLabel(cluster)}
              </span>
              {active && (
                <HugeiconsIcon
                  icon={CheckmarkCircle01Icon}
                  size={14}
                  strokeWidth={1.8}
                  className="text-primary"
                />
              )}
            </DropdownMenuItem>
          );
        })}
        <DropdownMenuSeparator />
        <p className="px-3 py-2 text-[11.5px] leading-4 text-muted-foreground">
          Switching reloads Onyx so wallet, RPC, Umbra indexer, and local records
          use the selected network.
        </p>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
