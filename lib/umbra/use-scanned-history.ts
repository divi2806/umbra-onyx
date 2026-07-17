"use client";

import { getBurnableStealthPoolNoteScannerFunction } from "@umbra-privacy/sdk/burn";
import { useWallet } from "@solana/wallet-adapter-react";
import * as React from "react";

import { solanaConfig } from "@/lib/solana/config";
import { getShieldTokenByMint } from "./tokens";
import {
  clearScan,
  isScanStale,
  loadScan,
  mergeScanReports,
  mintFromLowHigh,
  saveScan,
  selectReceivedUtxos,
  timestampComponentsToMs,
  type ReceivedUtxo,
  type StoredScan,
} from "./scanned-history";
import { useUmbraClient } from "./client";

export type ScanStatus = "idle" | "scanning" | "success" | "error";

export type UseScannedHistory = {
  scan: StoredScan | null;
  received: ReceivedUtxo[];
  status: ScanStatus;
  progress: string | null;
  error: Error | null;
  /** Run (or re-run) an incremental scan. */
  sync: () => Promise<StoredScan>;
  /** Drop the persisted cache and re-scan from tree head. */
  reset: () => Promise<StoredScan | null>;
};

const STALE_AFTER_MS = 5 * 60 * 1000;

export function useScannedHistory(): UseScannedHistory {
  const wallet = useWallet();
  const sender = wallet.publicKey?.toBase58() ?? null;
  const client = useUmbraClient();

  const cacheRef = React.useRef<{
    sender: string | null;
    serialized: string;
    value: StoredScan | null;
  }>({ sender: null, serialized: "null", value: null });

  const subscribe = React.useCallback(
    (notify: () => void) => {
      if (typeof window === "undefined") return () => {};
      const onCustom = (e: Event) => {
        const detail = (e as CustomEvent<{ wallet: string; cluster: string }>)
          .detail;
        if (
          !detail ||
          (detail.wallet === sender && detail.cluster === solanaConfig.cluster)
        ) {
          notify();
        }
      };
      const onStorage = (e: StorageEvent) => {
        if (!e.key) return;
        if (e.key.startsWith("onyx:scanned:v1:")) notify();
      };
      window.addEventListener("onyx:scanned-updated", onCustom);
      window.addEventListener("storage", onStorage);
      return () => {
        window.removeEventListener("onyx:scanned-updated", onCustom);
        window.removeEventListener("storage", onStorage);
      };
    },
    [sender],
  );

  const getSnapshot = React.useCallback(() => {
    if (typeof window === "undefined") return cacheRef.current.value;
    const fresh = loadScan(sender, solanaConfig.cluster);
    const serialized = JSON.stringify(fresh);
    const cache = cacheRef.current;
    if (cache.sender === sender && cache.serialized === serialized) {
      return cache.value;
    }
    cacheRef.current = { sender, serialized, value: fresh };
    return fresh;
  }, [sender]);

  const scan = React.useSyncExternalStore(subscribe, getSnapshot, () => null);

  const [status, setStatus] = React.useState<ScanStatus>("idle");
  const [progress, setProgress] = React.useState<string | null>(null);
  const [error, setError] = React.useState<Error | null>(null);

  const inflightRef = React.useRef<Promise<StoredScan> | null>(null);

  const sync = React.useCallback(async () => {
    if (!sender) throw new Error("Connect your wallet first.");
    if (!client) throw new Error("Umbra client not ready.");
    if (inflightRef.current) return inflightRef.current;

    const previous = loadScan(sender, solanaConfig.cluster);
    const prevReport = previous?.report ?? null;

    setStatus("scanning");
    setError(null);
    setProgress("Scanning for received payments");

    const run = (async () => {
      try {
        const scanner = getBurnableStealthPoolNoteScannerFunction({ client });

        const freshUtxos: ReceivedUtxo[] = [];
        const nextIndexByTree: Record<string, number> = {};

        const result = await scanner();
        for (const tree of result.scannedTrees) {
          nextIndexByTree[String(tree.treeIndex)] = Number(tree.totalLeaves);
        }

        const allReceived = [
          ...result.etaToStealthPoolReceiverBurnable,
          ...result.ataToStealthPoolReceiverBurnable,
          ...result.networkBalanceToStealthPoolReceiverBurnableWithEncryptedAddress,
        ];

        for (const utxo of allReceived) {
            const mint = mintFromLowHigh(
              BigInt(utxo.h1Components.mintAddressLow),
              BigInt(utxo.h1Components.mintAddressHigh),
            );
            const token = getShieldTokenByMint(mint);
            freshUtxos.push({
              treeIndex: Number(utxo.treeIndex),
              insertionIndex: Number(utxo.insertionIndex),
              amount: String(utxo.amount),
              mint,
              decimals: token?.decimals ?? 9,
              symbol: token?.id ?? "",
              destinationAddress: utxo.destinationAddress,
              timestamp: timestampComponentsToMs(utxo.h1Components.timestamp),
            });
        }

        const freshReport = {
          utxos: freshUtxos,
          nextScanStartIndexByTree: nextIndexByTree,
          transactionCount: freshUtxos.length,
        };

        const merged = mergeScanReports(prevReport, freshReport);
        const stored = saveScan(sender, solanaConfig.cluster, merged);

        setStatus("success");
        setProgress(null);
        return stored;
      } catch (err) {
        const e = err instanceof Error ? err : new Error(String(err));
        setError(e);
        setStatus("error");
        setProgress(null);
        throw e;
      } finally {
        inflightRef.current = null;
      }
    })();

    inflightRef.current = run;
    return run;
  }, [sender, client]);

  const autoSyncedFor = React.useRef<string | null>(null);
  React.useEffect(() => {
    if (!sender || !client) return;
    if (autoSyncedFor.current === sender) return;
    autoSyncedFor.current = sender;
    const cached = loadScan(sender, solanaConfig.cluster);
    if (cached && !isScanStale(cached, STALE_AFTER_MS)) return;
    void sync().catch(() => {
      // surfaced via `error` state
    });
  }, [sender, client, sync]);

  const reset = React.useCallback(async () => {
    if (!sender) return null;
    clearScan(sender, solanaConfig.cluster);
    autoSyncedFor.current = null;
    return sync();
  }, [sender, sync]);

  const received = React.useMemo(
    () => selectReceivedUtxos(scan?.report),
    [scan],
  );

  return { scan, received, status, progress, error, sync, reset };
}
