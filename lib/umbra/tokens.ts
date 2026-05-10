import type { Address } from "@solana/kit";

import { solanaConfig, type SolanaCluster } from "@/lib/solana/config";

export type ShieldTokenId = "SOL" | "USDC" | "USDT" | "UMBRA";

export type ShieldToken = {
  id: ShieldTokenId;
  decimals: number;
  mint: Address;
};

// Umbra-supported token mints per cluster.
// Mainnet: USDC, USDT, wSOL (native SOL wrapped), UMBRA.
// Devnet: wSOL only — Umbra devnet does not have bridged stablecoin mints.
const REGISTRY: Record<SolanaCluster, Partial<Record<ShieldTokenId, Omit<ShieldToken, "id">>>> = {
  "mainnet-beta": {
    SOL: {
      decimals: 9,
      mint: "So11111111111111111111111111111111111111112" as Address,
    },
    USDC: {
      decimals: 6,
      mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" as Address,
    },
    USDT: {
      decimals: 6,
      mint: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB" as Address,
    },
    UMBRA: {
      decimals: 6,
      mint: "PRVT6TB7uss3FrUd2D9xs2zqDBsa3GbMJMwCQsgmeta" as Address,
    },
  },
  devnet: {
    SOL: {
      decimals: 9,
      mint: "So11111111111111111111111111111111111111112" as Address,
    },
  },
  testnet: {
    SOL: {
      decimals: 9,
      mint: "So11111111111111111111111111111111111111112" as Address,
    },
  },
  localnet: {
    SOL: {
      decimals: 9,
      mint: "So11111111111111111111111111111111111111112" as Address,
    },
  },
};

export function getShieldToken(id: ShieldTokenId): ShieldToken | null {
  const entry = REGISTRY[solanaConfig.cluster]?.[id];
  if (!entry) return null;
  return { id, ...entry };
}

export function isShieldTokenSupported(id: ShieldTokenId): boolean {
  return getShieldToken(id) !== null;
}

/** Returns all shield tokens supported for the current cluster. */
export function getShieldTokens(): ShieldToken[] {
  const cluster = REGISTRY[solanaConfig.cluster];
  if (!cluster) return [];
  return (Object.entries(cluster) as [ShieldTokenId, Omit<ShieldToken, "id"> | undefined][])
    .filter((entry): entry is [ShieldTokenId, Omit<ShieldToken, "id">] => entry[1] !== undefined)
    .map(([id, entry]) => ({ id, ...entry }));
}

export function getShieldTokenByMint(mint: string): ShieldToken | null {
  const cluster = REGISTRY[solanaConfig.cluster];
  if (!cluster) return null;
  for (const id of Object.keys(cluster) as ShieldTokenId[]) {
    const entry = cluster[id];
    if (entry && entry.mint === mint) {
      return { id, ...entry };
    }
  }
  return null;
}

/** Convert a human-readable decimal string (e.g. "1.50") to base-unit bigint. */
export function toBaseUnits(amount: string, decimals: number): bigint {
  const [whole, frac = ""] = amount.trim().split(".");
  const fracPadded = (frac + "0".repeat(decimals)).slice(0, decimals);
  const base = 10n ** BigInt(decimals);
  return BigInt(whole || "0") * base + BigInt(fracPadded || "0");
}
