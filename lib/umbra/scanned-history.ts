import { PublicKey } from "@solana/web3.js";

import type { SolanaCluster } from "@/lib/solana/config";

const STORAGE_PREFIX = "onyx:scanned:v1";

export type ReceivedUtxoClaimState =
  | "pending"
  | "processing"
  | "withdrawal_queued"
  | "transferred";

/** A single UTXO received by this wallet, enriched with token metadata. */
export type ReceivedUtxo = {
  treeIndex: number;
  insertionIndex: number;
  /** Base-unit amount as a decimal string (bigint-safe). */
  amount: string;
  /** SPL mint address (base58). */
  mint: string;
  decimals: number;
  /** Token symbol, e.g. "SOL", "USDC". Empty string if unknown. */
  symbol: string;
  /** Destination address (base58) — the wallet the UTXO was sent to. */
  destinationAddress: string;
  /** Unix ms timestamp of the UTXO creation block. */
  timestamp: number;
  /** Local claim/withdraw state for ledger display. Missing means pending. */
  claimState?: ReceivedUtxoClaimState;
  claimStateUpdatedAt?: number;
};

/**
 * The serializable scan state stored in localStorage.
 * `nextScanStartIndexByTree` lets us do incremental re-scans cheaply:
 * on the next sync we pass the stored value as `startInsertionIndex`
 * for each tree, so we only process new UTXOs.
 */
export type ScanReport = {
  utxos: ReceivedUtxo[];
  /** Maps tree index (stringified) → the `nextScanStartIndex` returned by the last scan. */
  nextScanStartIndexByTree: Record<string, number>;
  transactionCount: number;
};

export type StoredScan = {
  wallet: string;
  cluster: SolanaCluster;
  report: ScanReport;
  scannedAt: number;
};

function key(wallet: string, cluster: SolanaCluster): string {
  return `${STORAGE_PREFIX}:${cluster}:${wallet}`;
}

function isBrowser(): boolean {
  return (
    typeof window !== "undefined" && typeof window.localStorage !== "undefined"
  );
}

function notify(wallet: string, cluster: SolanaCluster): void {
  if (!isBrowser()) return;
  window.dispatchEvent(
    new CustomEvent("onyx:scanned-updated", {
      detail: { wallet, cluster },
    }),
  );
}

export function loadScan(
  wallet: string | null | undefined,
  cluster: SolanaCluster,
): StoredScan | null {
  if (!isBrowser() || !wallet) return null;
  try {
    const raw = window.localStorage.getItem(key(wallet, cluster));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StoredScan;
    if (!parsed || parsed.wallet !== wallet) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function saveScan(
  wallet: string,
  cluster: SolanaCluster,
  report: ScanReport,
): StoredScan {
  const stored: StoredScan = { wallet, cluster, report, scannedAt: Date.now() };
  if (!isBrowser()) return stored;
  try {
    window.localStorage.setItem(key(wallet, cluster), JSON.stringify(stored));
    notify(wallet, cluster);
  } catch {
    // ignore quota / serialization errors
  }
  return stored;
}

export function clearScan(wallet: string, cluster: SolanaCluster): void {
  if (!isBrowser()) return;
  try {
    window.localStorage.removeItem(key(wallet, cluster));
    notify(wallet, cluster);
  } catch {
    // ignore
  }
}

export function receivedUtxoKey(utxo: Pick<ReceivedUtxo, "treeIndex" | "insertionIndex">): string {
  return `${utxo.treeIndex}:${utxo.insertionIndex}`;
}

export function markReceivedUtxosClaimState(
  wallet: string,
  cluster: SolanaCluster,
  ids: readonly string[],
  claimState: ReceivedUtxoClaimState,
): StoredScan | null {
  const stored = loadScan(wallet, cluster);
  if (!stored || ids.length === 0) return stored;

  const idSet = new Set(ids);
  let changed = false;
  const updatedAt = Date.now();
  const utxos = stored.report.utxos.map((utxo) => {
    if (!idSet.has(receivedUtxoKey(utxo))) return utxo;
    changed = true;
    return {
      ...utxo,
      claimState,
      claimStateUpdatedAt: updatedAt,
    };
  });

  if (!changed) return stored;

  return saveScan(wallet, cluster, {
    ...stored.report,
    utxos,
  });
}

/**
 * Merge a fresh scan result into the existing report.
 * Deduplicates by (treeIndex, insertionIndex) and advances the cursor
 * for each tree that was scanned.
 */
export function mergeScanReports(
  prev: ScanReport | null | undefined,
  next: ScanReport,
): ScanReport {
  if (!prev) return next;

  const seen = new Set<string>();
  for (const u of prev.utxos) {
    seen.add(`${u.treeIndex}:${u.insertionIndex}`);
  }

  const fresh = next.utxos.filter((u) => !seen.has(`${u.treeIndex}:${u.insertionIndex}`));

  const merged = [...fresh, ...prev.utxos].sort((a, b) => b.timestamp - a.timestamp);

  const nextIndexByTree: Record<string, number> = {
    ...prev.nextScanStartIndexByTree,
    ...next.nextScanStartIndexByTree,
  };

  return {
    utxos: merged,
    nextScanStartIndexByTree: nextIndexByTree,
    transactionCount: merged.length,
  };
}

/** Returns received UTXOs sorted newest-first. */
export function selectReceivedUtxos(
  report: ScanReport | null | undefined,
): ReceivedUtxo[] {
  if (!report) return [];
  return [...report.utxos].sort((a, b) => b.timestamp - a.timestamp);
}

/** True when the cached scan is missing or older than `staleAfterMs`. */
export function isScanStale(scan: StoredScan | null, staleAfterMs: number): boolean {
  if (!scan) return true;
  return Date.now() - scan.scannedAt > staleAfterMs;
}

/**
 * Reconstruct a Solana base58 address from two U128 little-endian bigints.
 * Umbra stores 32-byte addresses split into low (bytes 0–15) and high (bytes 16–31)
 * halves, each encoded as a little-endian 128-bit integer.
 */
export function mintFromLowHigh(low: bigint, high: bigint): string {
  const bytes = new Uint8Array(32);
  let v = BigInt.asUintN(128, low);
  for (let i = 0; i < 16; i++) {
    bytes[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  v = BigInt.asUintN(128, high);
  for (let i = 16; i < 32; i++) {
    bytes[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return new PublicKey(bytes).toBase58();
}

/** Convert Umbra TimestampComponents to Unix milliseconds. */
export function timestampComponentsToMs(ts: {
  year: bigint;
  month: bigint;
  day: bigint;
  hour: bigint;
  minute: bigint;
  second: bigint;
}): number {
  return Date.UTC(
    Number(ts.year),
    Number(ts.month) - 1, // JS months are 0-indexed
    Number(ts.day),
    Number(ts.hour),
    Number(ts.minute),
    Number(ts.second),
  );
}
