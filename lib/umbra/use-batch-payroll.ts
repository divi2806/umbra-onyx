"use client";

import { useWallet } from "@solana/wallet-adapter-react";
import { fromLegacyPublicKey } from "@solana/compat";
import { PublicKey } from "@solana/web3.js";
import type { Address } from "@solana/kit";
import * as React from "react";

import { useUmbraClient } from "./client";
import { umbraSendOnce } from "./umbra-send-core";

export type BatchRowInput = {
  id: number;
  recipient: string; // base58
  amountBaseUnits: bigint;
};

export type BatchRowStatus =
  | "pending"
  | "paying-proof"
  | "paying-submit"
  | "confirmed"
  | "failed";

export type BatchRowState = {
  status: BatchRowStatus;
  progress: string | null;
  /** createUtxoSignature once confirmed. */
  createUtxoSignature?: string;
  errorMessage?: string;
};

export type BatchRunStatus = "idle" | "running" | "done";

export type BatchPhase =
  | "idle"
  | "paying"
  | "done"
  | "error";

export type BatchRunSummary = {
  total: number;
  confirmed: number;
  failed: number;
  startedAt: number;
  finishedAt: number;
  /** Signature of the first UTXO creation (used as the batch ID). */
  firstSignature: string | null;
};

export type BatchPayrollState = {
  status: BatchRunStatus;
  phase: BatchPhase;
  rows: Record<number, BatchRowState>;
  activeRowId: number | null;
  activeStartedAt: number | null;
  summary: BatchRunSummary | null;
};

const initialState: BatchPayrollState = {
  status: "idle",
  phase: "idle",
  rows: {},
  activeRowId: null,
  activeStartedAt: null,
  summary: null,
};

export type RunBatchArgs = {
  rows: BatchRowInput[];
  mint: string; // base58 mint address
  tokenId: string;
  decimals: number;
};

export function useBatchPayroll() {
  const wallet = useWallet();
  const client = useUmbraClient();
  const [state, setState] = React.useState<BatchPayrollState>(initialState);
  const cancelRef = React.useRef(false);

  const reset = React.useCallback(() => {
    cancelRef.current = false;
    setState(initialState);
  }, []);

  const cancel = React.useCallback(() => {
    cancelRef.current = true;
  }, []);

  const run = React.useCallback(
    async ({ rows, mint }: RunBatchArgs) => {
      if (!wallet.publicKey) throw new Error("Connect your wallet first.");
      if (!client) throw new Error("Umbra client not ready.");
      if (rows.length === 0) return null;

      cancelRef.current = false;
      const startedAt = Date.now();
      const mintAddress = mint as Address;

      const initialRows: Record<number, BatchRowState> = {};
      for (const r of rows) {
        initialRows[r.id] = { status: "pending", progress: null };
      }

      setState({
        status: "running",
        phase: "paying",
        rows: initialRows,
        activeRowId: null,
        activeStartedAt: Date.now(),
        summary: null,
      });

      let confirmed = 0;
      let failed = 0;
      let firstSignature: string | null = null;

      for (const row of rows) {
        if (cancelRef.current) break;

        setState((s) => ({
          ...s,
          activeRowId: row.id,
          activeStartedAt: Date.now(),
          rows: {
            ...s.rows,
            [row.id]: { status: "paying-proof", progress: "Generating proof" },
          },
        }));

        try {
          const recipient = fromLegacyPublicKey(
            new PublicKey(row.recipient),
          ) as Address;

          const result = await umbraSendOnce({
            amountBaseUnits: row.amountBaseUnits,
            mint: mintAddress,
            recipient,
            client,
            onPhase: (phase) => {
              setState((s) => ({
                ...s,
                rows: {
                  ...s.rows,
                  [row.id]: {
                    ...s.rows[row.id],
                    status: phase === "submit" ? "paying-submit" : "paying-proof",
                  },
                },
              }));
            },
            onProgress: (msg) => {
              setState((s) => ({
                ...s,
                rows: {
                  ...s.rows,
                  [row.id]: { ...s.rows[row.id], progress: msg },
                },
              }));
            },
          });

          if (!firstSignature) firstSignature = result.createUtxoSignature;

          confirmed += 1;
          setState((s) => ({
            ...s,
            rows: {
              ...s.rows,
              [row.id]: {
                status: "confirmed",
                progress: null,
                createUtxoSignature: result.createUtxoSignature,
              },
            },
          }));
        } catch (err) {
          failed += 1;
          const msg = err instanceof Error ? err.message : String(err);
          setState((s) => ({
            ...s,
            rows: {
              ...s.rows,
              [row.id]: {
                status: "failed",
                progress: null,
                errorMessage: msg,
              },
            },
          }));
        }
      }

      const finishedAt = Date.now();
      const summary: BatchRunSummary = {
        total: rows.length,
        confirmed,
        failed,
        startedAt,
        finishedAt,
        firstSignature,
      };

      setState((s) => ({
        ...s,
        status: "done",
        phase: failed > 0 && confirmed === 0 ? "error" : "done",
        activeRowId: null,
        summary,
      }));

      return summary;
    },
    [client, wallet.publicKey],
  );

  return { ...state, run, reset, cancel };
}
