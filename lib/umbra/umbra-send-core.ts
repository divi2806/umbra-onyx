"use client";

import {
  getPublicBalanceToReceiverClaimableUtxoCreatorFunction,
  getUmbraClient,
} from "@umbra-privacy/sdk";
import {
  getCreateReceiverClaimableUtxoFromPublicBalanceProver,
  type ZkAssetData,
  type ZkAssetLoadResult,
  type ZkAssetStorageContext,
  type ZkAssetStoreResult,
} from "@umbra-privacy/web-zk-prover";
import type { Address } from "@solana/kit";
import type { U64 } from "@umbra-privacy/sdk/types";

import {
  assertUmbraReceiverReady,
  ensureUmbraFullRegistration,
  randomUmbraGenerationIndex,
} from "./client";

type IUmbraClient = Awaited<ReturnType<typeof getUmbraClient>>;

/** Recursively collects error messages from a cause chain into one string. */
function collectCauses(err: unknown, depth = 0): string {
  if (!err || depth > 8) return "";
  if (typeof err === "string") return err;
  if (err instanceof Error) {
    const parts = [err.message];
    const cause = (err as Error & { cause?: unknown }).cause;
    if (cause) {
      const sub = collectCauses(cause, depth + 1);
      if (sub) parts.push(sub);
    }
    // Some Kit/RPC errors embed logs as an array on the error context.
    const ctx = (err as Error & { context?: { logs?: string[] } }).context;
    if (ctx?.logs?.length) parts.push(ctx.logs.join("\n"));
    return parts.join(" → ");
  }
  return String(err);
}

export type UmbraSendPhase =
  | "proof"
  | "submit"
  | "success";

export type UmbraSendCallbacks = {
  onPhase?: (phase: UmbraSendPhase) => void;
  onProgress?: (message: string) => void;
};

export type UmbraSendOnceArgs = {
  amountBaseUnits: bigint;
  mint: Address;
  recipient: Address;
  client: IUmbraClient;
} & UmbraSendCallbacks;

export type UmbraSendOnceResult = {
  /** Signature of the proof account creation transaction. */
  createProofAccountSignature: string;
  /** Signature of the UTXO creation transaction (funds leave sender's wallet here). */
  createUtxoSignature: string;
};

// ---------------------------------------------------------------------------
// In-memory ZK asset cache
// The .zkey proving key is ~50-200 MB and the .wasm circuit file is large too.
// Caching them in memory means the CDN download only happens once per page load.
// ---------------------------------------------------------------------------
const _zkAssetCache = new Map<string, ZkAssetData>();

function cacheKey(ctx: ZkAssetStorageContext): string {
  return `${ctx.type}/${ctx.variant ?? ""}`;
}

const zkAssetLoader = async (ctx: ZkAssetStorageContext): Promise<ZkAssetLoadResult> => {
  const key = cacheKey(ctx);
  const cached = _zkAssetCache.get(key);
  if (cached) {
    console.log("[umbra-prover] cache HIT for ZK assets:", key);
    return { exists: true, data: cached };
  }
  console.log("[umbra-prover] cache MISS for ZK assets:", key);
  return { exists: false };
};

const zkAssetStorer = async (
  data: ZkAssetData,
  ctx: ZkAssetStorageContext,
): Promise<ZkAssetStoreResult> => {
  const key = cacheKey(ctx);
  _zkAssetCache.set(key, data);
  console.log("[umbra-prover] cached ZK assets:", key, {
    zkeyBytes: data.zkey.byteLength,
    wasmBytes: data.wasm.byteLength,
  });
  return { success: true };
};

// ---------------------------------------------------------------------------
// Build a prover instance with full progress callbacks.
// We create a fresh one per call so the `onProgress` closure is always current.
// Asset downloads are amortised by the cache above.
// ---------------------------------------------------------------------------
function buildZkProver(t0: number, onProgress?: (msg: string) => void) {
  return getCreateReceiverClaimableUtxoFromPublicBalanceProver({
    load: zkAssetLoader,
    store: zkAssetStorer,
    callbacks: {
      onManifestFetch: {
        pre: async () => {
          console.log(`[umbra-prover] fetching ZK circuit manifest from CDN... (${Date.now() - t0}ms)`);
          onProgress?.("Fetching ZK circuit manifest…");
        },
        post: async () => {
          console.log(`[umbra-prover] manifest fetched (${Date.now() - t0}ms)`);
        },
      },
      onZkeyDownload: {
        pre: async () => {
          console.log(`[umbra-prover] downloading ZK proving key from CDN (may be 50-200 MB)... (${Date.now() - t0}ms)`);
          onProgress?.("Downloading ZK proving key — this may take a minute on first use…");
        },
        post: async () => {
          console.log(`[umbra-prover] ✔ ZK proving key downloaded (${Date.now() - t0}ms)`);
          onProgress?.("ZK proving key ready.");
        },
      },
      onWasmDownload: {
        pre: async () => {
          console.log(`[umbra-prover] downloading WASM circuit... (${Date.now() - t0}ms)`);
          onProgress?.("Downloading WASM circuit…");
        },
        post: async () => {
          console.log(`[umbra-prover] ✔ WASM circuit downloaded (${Date.now() - t0}ms)`);
          onProgress?.("WASM circuit ready.");
        },
      },
      onWitnessGeneration: {
        pre: async () => {
          console.log(`[umbra-prover] generating witness (blocks main thread briefly)... (${Date.now() - t0}ms)`);
          onProgress?.("Generating ZK witness…");
        },
        post: async () => {
          console.log(`[umbra-prover] ✔ witness generated (${Date.now() - t0}ms)`);
        },
      },
      onProofComputation: {
        pre: async () => {
          console.log(`[umbra-prover] computing Groth16 proof (blocks main thread ~30-120s)... (${Date.now() - t0}ms)`);
          onProgress?.("Computing ZK proof — keep this tab open (may take 30-120 seconds)…");
        },
        post: async () => {
          console.log(`[umbra-prover] ✔ Groth16 proof computed! (${Date.now() - t0}ms)`);
          onProgress?.("ZK proof ready.");
        },
      },
      onLog: (msg: string) => {
        console.log("[umbra-prover] snarkjs:", msg);
      },
      onError: (msg: string) => {
        console.error("[umbra-prover] prover error:", msg);
      },
    },
  });
}

export async function umbraSendOnce(
  args: UmbraSendOnceArgs,
): Promise<UmbraSendOnceResult> {
  const { amountBaseUnits, mint, recipient, client, onPhase, onProgress } =
    args;

  const t0 = Date.now();
  console.log("[umbra-send] ▶ umbraSendOnce start", {
    amountBaseUnits: amountBaseUnits.toString(),
    mint,
    recipient,
    signerAddress: client.signer.address,
    network: (client as { network?: string }).network,
  });

  onPhase?.("proof");
  onProgress?.("Preparing Umbra sender registration…");
  await ensureUmbraFullRegistration(client, { onProgress });

  onProgress?.("Checking recipient Umbra account…");

  console.log("[umbra-send] asserting recipient is Umbra-ready:", recipient);
  try {
    await assertUmbraReceiverReady(client, recipient);
  } catch (err) {
    console.error("[umbra-send] recipient readiness check FAILED:", err);
    throw err;
  }
  console.log(`[umbra-send] recipient ready (${Date.now() - t0}ms)`);

  console.log("[umbra-send] building ZK prover with progress callbacks...");
  const zkProver = buildZkProver(t0, onProgress);
  console.log("[umbra-send] ZK prover built, creating UTXO function...");

  const createUtxo = getPublicBalanceToReceiverClaimableUtxoCreatorFunction(
    { client },
    {
      zkProver,
      hooks: {
        createUtxo: {
          pre: async () => {
            console.log(`[umbra-send] ✔ proof phase complete (${Date.now() - t0}ms) — wallet signing now`);
            onPhase?.("submit");
            onProgress?.("Signing and submitting Umbra UTXO transaction…");
          },
          post: async () => {
            console.log(`[umbra-send] ✔ UTXO transaction confirmed (${Date.now() - t0}ms)`);
            onProgress?.("Umbra UTXO transaction confirmed.");
          },
        },
      },
    },
  );

  const genIndex = randomUmbraGenerationIndex();
  console.log(`[umbra-send] calling createUtxo (${Date.now() - t0}ms) generationIndex:`, genIndex.toString());
  onProgress?.("Generating ZK proof (this may take a few seconds on first use)…");

  let result: Awaited<ReturnType<typeof createUtxo>>;
  try {
    result = await createUtxo({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      amount: amountBaseUnits as any as U64,
      mint,
      destinationAddress: recipient,
    }, {
      generationIndex: genIndex,
    });
  } catch (err) {
    const fullMessage = collectCauses(err);
    console.error("[umbra-send] ✖ createUtxo FAILED after", Date.now() - t0, "ms");
    console.error("[umbra-send] full error chain:", fullMessage);
    console.error("[umbra-send] raw error:", err);

    const lower = fullMessage.toLowerCase();
    if (
      lower.includes("not registered")
      || lower.includes("does not have x25519")
      || lower.includes("does not have user commitment")
    ) {
      throw new Error(
        "Recipient wallet is not fully registered with Umbra. Ask them to create an invoice or connect once so Umbra can register their encrypted user account and anonymous commitment.",
      );
    }
    if (lower.includes("duplicate offset") || lower.includes("already in use")) {
      throw new Error(
        "Umbra proof offset collision. Retry the send; a fresh random generation index will be used.",
      );
    }
    if (
      lower.includes("accountnotinitialized")
      || lower.includes("account not initialized")
      || lower.includes("3012")
      || lower.includes("0xbc4")
      || lower.includes("depositor_user_account")
      || lower.includes("encrypteduseraccountisactiveforanonymoususagebitmustbeset")
      || lower.includes("active for anonymous usage bit must be set")
      || lower.includes("18003")
      || lower.includes("0x4653")
    ) {
      throw new Error(
        "Umbra sender registration is not complete yet. Send now requires full Umbra registration before creating the UTXO; retry after registration finishes.",
      );
    }
    if (lower.includes("insufficient lamports") || lower.includes("insufficient funds")) {
      throw new Error(
        "Your wallet doesn't have enough SOL to pay for the Umbra proof account (needs ~0.01 SOL). Top up your wallet and try again.",
      );
    }

    throw new Error(fullMessage || String(err));
  }

  console.log(`[umbra-send] ✔ success (${Date.now() - t0}ms)`, {
    createProofAccountSignature: result.createProofAccountSignature,
    createUtxoSignature: result.createUtxoSignature,
  });

  onPhase?.("success");

  return {
    createProofAccountSignature: result.createProofAccountSignature,
    createUtxoSignature: result.createUtxoSignature,
  };
}
