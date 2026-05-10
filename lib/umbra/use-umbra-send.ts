"use client";

import { useWallet } from "@solana/wallet-adapter-react";
import type { Address } from "@solana/kit";
import { fromLegacyPublicKey } from "@solana/compat";
import { PublicKey } from "@solana/web3.js";
import * as React from "react";

import { useUmbraClient } from "./client";
import {
  umbraSendOnce,
  type UmbraSendPhase,
} from "./umbra-send-core";

export type UmbraSendStatus =
  | "idle"
  | "proof"
  | "submit"
  | "success"
  | "error";

export type UmbraSendState = {
  status: UmbraSendStatus;
  progress: string | null;
  uiPercent: number;
  createProofAccountSignature: string | null;
  createUtxoSignature: string | null;
  error: Error | null;
};

const initialState: UmbraSendState = {
  status: "idle",
  progress: null,
  uiPercent: 0,
  createProofAccountSignature: null,
  createUtxoSignature: null,
  error: null,
};

const PHASE_WINDOW: Record<
  Exclude<UmbraSendStatus, "idle" | "error">,
  { enter: number; ceiling: number }
> = {
  proof: { enter: 8, ceiling: 82 },
  submit: { enter: 84, ceiling: 96 },
  success: { enter: 100, ceiling: 100 },
};

export function useUmbraSend() {
  const wallet = useWallet();
  const client = useUmbraClient();
  const [state, setState] = React.useState<UmbraSendState>(initialState);

  const reset = React.useCallback(() => setState(initialState), []);

  React.useEffect(() => {
    if (state.status !== "proof") return;
    const id = window.setInterval(() => {
      setState((s) => {
        if (s.status !== "proof") return s;
        return {
          ...s,
          uiPercent: Math.min(s.uiPercent + 1, PHASE_WINDOW.proof.ceiling),
        };
      });
    }, 1_500);
    return () => window.clearInterval(id);
  }, [state.status]);

  const send = React.useCallback(
    async ({
      amountBaseUnits,
      mintAddress,
      recipientAddress,
    }: {
      amountBaseUnits: bigint;
      mintAddress: string;
      recipientAddress: string;
    }): Promise<{ createProofAccountSignature: string; createUtxoSignature: string }> => {
      if (!wallet.publicKey) throw new Error("Connect your wallet first.");
      if (!client) throw new Error("Umbra client not ready.");

      const mint = mintAddress as Address;
      const recipient = fromLegacyPublicKey(new PublicKey(recipientAddress)) as Address;

      try {
        setState({
          ...initialState,
          status: "proof",
          progress: "Checking recipient Umbra account",
          uiPercent: PHASE_WINDOW.proof.enter,
        });

        const result = await umbraSendOnce({
          amountBaseUnits,
          mint,
          recipient,
          client,
          onPhase: (phase) =>
            setState((s) => applyPhase(s, phase)),
          onProgress: (msg) =>
            setState((s) => applyProgress(s, msg)),
        });

        setState({
          status: "success",
          progress: null,
          uiPercent: 100,
          createProofAccountSignature: result.createProofAccountSignature,
          createUtxoSignature: result.createUtxoSignature,
          error: null,
        });

        return result;
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        setState((s) => ({
          status: "error",
          progress: null,
          uiPercent: 0,
          createProofAccountSignature: s.createProofAccountSignature,
          createUtxoSignature: null,
          error,
        }));
        throw error;
      }
    },
    [client, wallet.publicKey],
  );

  return { ...state, send, reset };
}

function applyPhase(s: UmbraSendState, phase: UmbraSendPhase): UmbraSendState {
  if (s.status === "error" || s.status === "success") return s;
  const w = PHASE_WINDOW[phase];
  return { ...s, status: phase, uiPercent: Math.max(s.uiPercent, w.enter) };
}

function applyProgress(s: UmbraSendState, message: string): UmbraSendState {
  if (s.status === "error" || s.status === "success") return s;
  const w = PHASE_WINDOW[s.status as keyof typeof PHASE_WINDOW];
  const nextPercent = w
    ? Math.min(s.uiPercent + 3, w.ceiling)
    : s.uiPercent;
  return { ...s, progress: message, uiPercent: Math.max(s.uiPercent, nextPercent) };
}
