"use client";

import {
  getPollingComputationMonitor,
  getUmbraClient,
  getUserAccountQuerierFunction,
  getUserRegistrationFunction,
} from "@umbra-privacy/sdk";
import { getUserRegistrationProver } from "@umbra-privacy/web-zk-prover";
import {
  createSolanaRpc,
  getBase64EncodedWireTransaction,
  signature as kitSignature,
  type Address,
} from "@solana/kit";
import type { U256 } from "@umbra-privacy/sdk/types";
import { useWallet } from "@solana/wallet-adapter-react";
import * as React from "react";

import { umbraConfig } from "./config";
import { createUmbraSigner } from "./signer";

// ---------------------------------------------------------------------------
// Custom transaction forwarder
// ---------------------------------------------------------------------------
// The default getWebsocketTransactionForwarder uses @solana/kit's
// sendAndConfirmTransactionFactory which:
//   1. Runs preflight simulation (skipPreflight = false by default).
//   2. Waits for confirmation via a WebSocket subscription.
//
// Both behaviours cause problems on public devnet/mainnet RPC endpoints:
//   - Preflight simulation often fails for Umbra instructions even when the
//     on-chain execution would succeed (stale simulated state, compute budget
//     differences between simulation and execution, devnet program version lag).
//   - Public WebSocket endpoints are rate-limited and frequently drop
//     subscriptions mid-flight, causing spurious confirmation timeouts.
//
// This forwarder replaces both with:
//   - skipPreflight: true  → let the on-chain program be the source of truth.
//   - HTTP polling         → reliable confirmation without a persistent WS.
// ---------------------------------------------------------------------------

type ITransactionForwarder = {
  forwardSequentially(txs: unknown[], opts?: unknown): Promise<string[]>;
  forwardInParallel(txs: unknown[], opts?: unknown): Promise<string[]>;
  fireAndForget(tx: unknown): Promise<string>;
};

/** JSON.stringify that converts BigInt to string so it doesn't throw. */
function safeStringify(val: unknown): string {
  return JSON.stringify(val, (_, v) => (typeof v === "bigint" ? v.toString() : v));
}

/** Fetch program logs for a confirmed/failed transaction for debugging. */
async function fetchTxLogs(
  rpc: ReturnType<typeof createSolanaRpc>,
  sig: string,
): Promise<string[]> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tx = await (rpc as any)
      .getTransaction(kitSignature(sig), {
        maxSupportedTransactionVersion: 0,
        encoding: "json",
      })
      .send();
    return tx?.meta?.logMessages ?? [];
  } catch {
    return [];
  }
}

function buildPollingForwarder(rpcUrl: string): ITransactionForwarder {
  const rpc = createSolanaRpc(rpcUrl);

  async function sendAndPoll(tx: unknown): Promise<string> {
    // Serialize using the Kit encoder (same as SDK does internally).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const wire = getBase64EncodedWireTransaction(tx as any);

    console.log("[umbra-forwarder] sending transaction (skipPreflight=true)...");
    let sig: string;
    const sendWire = async (isRebroadcast = false): Promise<string> => {
      if (isRebroadcast) {
        console.log("[umbra-forwarder] rebroadcasting transaction...");
      }
      return (await rpc
        .sendTransaction(wire, {
          encoding: "base64",
          skipPreflight: true,
          maxRetries: BigInt(3),
        })
        .send()) as string;
    };

    try {
      sig = await sendWire();
    } catch (sendErr) {
      console.error("[umbra-forwarder] sendTransaction RPC call failed:", sendErr);
      throw sendErr;
    }
    console.log("[umbra-forwarder] transaction sent, sig:", sig);

    // Umbra withdrawals (and other Arcium MPC flows) queue a tx then finalize via
    // a callback minutes later. A 90s cap made the queue land on-chain while the
    // forwarder timed out before the callback — funds stayed in the encrypted pool
    // and the UI looked "successful" on the first signature only.
    const POLL_MS = 2_000;
    const deadline = Date.now() + 10 * 60 * 1000;
    const started = Date.now();
    let lastRebroadcastAt = started;
    let pollCount = 0;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, POLL_MS));
      pollCount++;
      const elapsed = Date.now() - started;

      // `sendTransaction` returning a signature only means the RPC accepted the
      // packet. Public devnet RPCs sometimes drop or fail to forward packets,
      // leaving `getSignatureStatuses` null forever. Re-broadcast the same
      // signed wire transaction for the first ~90s while the blockhash is
      // likely still valid. Duplicate broadcasts are safe: the signature is the
      // transaction id, so a landed tx will simply start returning a status.
      if (elapsed < 90_000 && Date.now() - lastRebroadcastAt >= 6_000) {
        lastRebroadcastAt = Date.now();
        try {
          const rebroadcastSig = await sendWire(true);
          if (rebroadcastSig !== sig) {
            console.warn(
              "[umbra-forwarder] rebroadcast returned a different signature",
              { original: sig, rebroadcast: rebroadcastSig },
            );
          }
        } catch (rebroadcastErr) {
          console.warn(
            "[umbra-forwarder] rebroadcast failed (will keep polling):",
            rebroadcastErr,
          );
        }
      }

      // After ~30s, search full history — devnet RPCs often drop recent-only hints.
      const searchHistory = elapsed > 30_000;
      console.log(`[umbra-forwarder] poll #${pollCount} sig=${sig.slice(0, 8)}… elapsed=${elapsed}ms searchHistory=${searchHistory}`);
      let resp;
      try {
        resp = await rpc
          .getSignatureStatuses([kitSignature(sig)], { searchTransactionHistory: searchHistory })
          .send();
      } catch (pollErr) {
        console.warn("[umbra-forwarder] getSignatureStatuses failed (will retry):", pollErr);
        continue;
      }
      const status = resp.value[0];
      if (!status) {
        console.log(`[umbra-forwarder] poll #${pollCount}: status null, retrying...`);
        continue;
      }
      if (status.err) {
        // Fetch program logs so the real on-chain error is visible in the console.
        const logs = await fetchTxLogs(rpc, sig);
        console.error("[umbra-forwarder] ✖ transaction failed on-chain");
        console.error("[umbra-forwarder] sig:", sig);
        console.error("[umbra-forwarder] err:", safeStringify(status.err));
        if (logs.length) {
          console.error("[umbra-forwarder] program logs:\n" + logs.join("\n"));
        }
        // Surface the last "Error:" log line as the human-readable message.
        const errLog = [...logs].reverse().find((l) => l.includes("Error:") || l.includes("error:"));
        const detail = errLog
          ? errLog.replace(/^.*?(Error:)/i, "Error:")
          : safeStringify(status.err);
        throw new Error(`Transaction failed on-chain: ${detail}`);
      }
      const level = status.confirmationStatus;
      console.log(`[umbra-forwarder] poll #${pollCount}: confirmationStatus=${level}`);
      if (level === "confirmed" || level === "finalized") {
        console.log(`[umbra-forwarder] ✔ confirmed after ${pollCount} polls (${Date.now() - started}ms), sig:`, sig);
        return sig;
      }
    }
    throw new Error(`Transaction not confirmed within 10 min (sig: ${sig})`);
  }

  return {
    forwardSequentially: async (txs) => {
      const out: string[] = [];
      for (const tx of txs) out.push(await sendAndPoll(tx));
      return out;
    },
    forwardInParallel: (txs) => Promise.all(txs.map(sendAndPoll)),
    fireAndForget: async (tx) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const wire = getBase64EncodedWireTransaction(tx as any);
      return (await rpc
        .sendTransaction(wire, { encoding: "base64", skipPreflight: true })
        .send()) as string;
    },
  };
}

// Singleton per RPC URL — rebuilt only when the config changes.
let _forwarder: ITransactionForwarder | null = null;
let _forwarderUrl = "";
function getForwarder(): ITransactionForwarder {
  if (!_forwarder || _forwarderUrl !== umbraConfig.rpcUrl) {
    _forwarder = buildPollingForwarder(umbraConfig.rpcUrl);
    _forwarderUrl = umbraConfig.rpcUrl;
  }
  return _forwarder;
}

type IUmbraClient = Awaited<ReturnType<typeof getUmbraClient>>;

export type UmbraClientStatus =
  | "idle"
  | "connecting"
  | "registering"
  | "ready"
  | "error";

export type UmbraRegistrationPhase =
  | "idle"
  | "confidential"
  | "anonymous"
  | "complete"
  | "partial"
  | "failed";

export type UmbraRegistrationState = {
  confidential: boolean;
  anonymous: boolean;
  phase: UmbraRegistrationPhase;
  message?: string;
};

type UmbraClientState =
  | { status: "idle" }
  | { status: "connecting" }
  | { status: "registering"; client: IUmbraClient; registration: UmbraRegistrationState }
  | { status: "ready"; client: IUmbraClient; registration: UmbraRegistrationState }
  | { status: "error"; error: Error };

const UmbraClientContext = React.createContext<UmbraClientState>({
  status: "idle",
});

// Lazy singleton — WASM loading deferred until first registration call.
let _regProver: ReturnType<typeof getUserRegistrationProver> | null = null;
function getRegProver() {
  if (!_regProver) _regProver = getUserRegistrationProver();
  return _regProver;
}

const fullRegistrationByAddress = new Map<string, Promise<void>>();

export type UmbraUserRegistrationStatus = {
  exists: boolean;
  confidential: boolean;
  anonymous: boolean;
};

export type UmbraActionProgress = {
  onProgress?: (message: string) => void;
};

type UserAccountData = {
  isUserAccountX25519KeyRegistered?: boolean;
  isUserCommitmentRegistered?: boolean;
  isActiveForAnonymousUsage?: boolean;
};

function registrationPhaseFromMessage(message: string): UmbraRegistrationPhase {
  const lower = message.toLowerCase();
  if (lower.includes("anonymous") || lower.includes("commitment")) return "anonymous";
  if (lower.includes("encryption key") || lower.includes("x25519")) return "confidential";
  if (lower.includes("ready")) return "complete";
  return "idle";
}

export function randomUmbraGenerationIndex(): U256 {
  const cryptoApi = globalThis.crypto;
  if (!cryptoApi?.getRandomValues) {
    throw new Error("Secure random generation is unavailable in this browser.");
  }

  const bytes = new Uint8Array(32);
  cryptoApi.getRandomValues(bytes);

  let value = 0n;
  for (let i = 0; i < bytes.length; i++) {
    value |= BigInt(bytes[i] ?? 0) << BigInt(i * 8);
  }
  return value as U256;
}

export async function queryUmbraUserRegistration(
  client: IUmbraClient,
  userAddress: Address,
): Promise<UmbraUserRegistrationStatus> {
  console.log("[umbra-reg] querying account for:", userAddress);
  const queryUserAccount = getUserAccountQuerierFunction({ client });
  let result;
  try {
    result = await queryUserAccount(userAddress);
  } catch (err) {
    console.error("[umbra-reg] getUserAccountQuerierFunction FAILED for:", userAddress, err);
    throw err;
  }
  console.log("[umbra-reg] query result state:", result.state, "for:", userAddress);
  if (result.state !== "exists") {
    console.log("[umbra-reg] account does not exist for:", userAddress);
    return { exists: false, confidential: false, anonymous: false };
  }

  const data = result.data as UserAccountData;
  const status = {
    exists: true,
    confidential: data.isUserAccountX25519KeyRegistered === true,
    anonymous:
      data.isActiveForAnonymousUsage === true
      && data.isUserCommitmentRegistered === true,
  };
  console.log("[umbra-reg] account status:", status, "for:", userAddress);
  return status;
}

export async function assertUmbraReceiverReady(
  client: IUmbraClient,
  recipient: Address,
): Promise<void> {
  console.log("[umbra-reg] assertUmbraReceiverReady for:", recipient);
  const status = await queryUmbraUserRegistration(client, recipient);
  if (!status.exists) {
    console.warn("[umbra-reg] recipient not registered:", recipient);
    throw new Error(
      "Recipient wallet is not registered with Umbra. Ask them to create an invoice or connect once so Umbra can create their encrypted user account.",
    );
  }
  if (!status.confidential || !status.anonymous) {
    console.warn("[umbra-reg] recipient registration incomplete:", status, recipient);
    throw new Error(
      "Recipient wallet has not completed Umbra registration yet. They need both the X25519 key and anonymous user commitment before they can receive shielded UTXOs.",
    );
  }
  console.log("[umbra-reg] ✔ recipient fully registered:", recipient);
}

export function ensureUmbraFullRegistration(
  client: IUmbraClient,
  options: UmbraActionProgress = {},
): Promise<void> {
  const address = client.signer.address;
  const existing = fullRegistrationByAddress.get(address);
  if (existing) return existing;

  const run = (async () => {
    const t0 = Date.now();
    console.log("[umbra-reg] ensureUmbraFullRegistration start for:", address);
    options.onProgress?.("Checking Umbra registration…");
    const current = await queryUmbraUserRegistration(client, address);
    console.log("[umbra-reg] current registration:", current);
    if (current.confidential && current.anonymous) {
      console.log(`[umbra-reg] ✔ already fully registered (${Date.now() - t0}ms)`);
      options.onProgress?.("Umbra registration ready.");
      return;
    }

    console.log("[umbra-reg] registration incomplete, starting registration flow...", current);
    const register = getUserRegistrationFunction(
      { client },
      { zkProver: getRegProver() },
    );

    try {
      await register({
        confidential: true,
        anonymous: true,
        callbacks: {
          userAccountInitialisation: {
            pre: async () => {
              console.log("[umbra-reg] userAccountInitialisation: pre");
              options.onProgress?.("Creating Umbra encrypted account…");
            },
            post: async () => {
              console.log("[umbra-reg] userAccountInitialisation: post ✔");
              options.onProgress?.("Umbra encrypted account ready.");
            },
          },
          registerX25519PublicKey: {
            pre: async () => {
              console.log("[umbra-reg] registerX25519PublicKey: pre");
              options.onProgress?.("Registering Umbra encryption key…");
            },
            post: async () => {
              console.log("[umbra-reg] registerX25519PublicKey: post ✔");
              options.onProgress?.("Umbra encryption key ready.");
            },
          },
          registerUserForAnonymousUsage: {
            pre: async () => {
              console.log("[umbra-reg] registerUserForAnonymousUsage: pre");
              options.onProgress?.("Registering Umbra anonymous commitment…");
            },
            post: async () => {
              console.log("[umbra-reg] registerUserForAnonymousUsage: post ✔");
              options.onProgress?.("Umbra anonymous commitment ready.");
            },
          },
        },
      });
    } catch (regErr) {
      console.error("[umbra-reg] register() FAILED:", regErr);
      throw regErr;
    }

    const next = await queryUmbraUserRegistration(client, address);
    console.log(`[umbra-reg] post-register status (${Date.now() - t0}ms):`, next);
    if (!next.confidential || !next.anonymous) {
      throw new Error(
        "Umbra registration transaction finished, but the account is not ready yet. Wait a moment and retry.",
      );
    }
    console.log(`[umbra-reg] ✔ registration complete (${Date.now() - t0}ms)`);
    options.onProgress?.("Umbra registration ready.");
  })();

  fullRegistrationByAddress.set(address, run);
  run.finally(() => {
    if (fullRegistrationByAddress.get(address) === run) {
      fullRegistrationByAddress.delete(address);
    }
  }).catch(() => {
    // The original caller receives the error. This cleanup chain only prevents
    // an unhandled rejection.
  });

  return run;
}

export function ensureUmbraAnonymousRegistration(
  client: IUmbraClient,
): Promise<void> {
  return ensureUmbraFullRegistration(client);
}

export function UmbraClientProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const wallet = useWallet();
  const [state, setState] = React.useState<UmbraClientState>({ status: "idle" });

  // Re-create the Umbra client whenever the connected wallet changes.
  // We key on the public-key string so reference-unstable wallet objects
  // don't trigger needless reconnects.
  const walletKey = wallet.publicKey?.toBase58() ?? null;

  React.useEffect(() => {
    if (!walletKey) {
      queueMicrotask(() => setState({ status: "idle" }));
      return;
    }

    const signer = createUmbraSigner(wallet);
    if (!signer) {
      queueMicrotask(() => setState({ status: "idle" }));
      return;
    }

    let cancelled = false;
    queueMicrotask(() => {
      if (!cancelled) setState({ status: "connecting" });
    });

    console.log("[umbra-client] creating Umbra client for wallet:", walletKey, "network:", umbraConfig.network);

    (async () => {
      console.log("[umbra-client] calling getUmbraClient...", {
        network: umbraConfig.network,
        rpcUrl: umbraConfig.rpcUrl,
        indexerApiEndpoint: umbraConfig.indexerApiEndpoint,
      });
      const t0 = Date.now();
      let client;
      try {
        client = await getUmbraClient(
          {
            signer,
            network: umbraConfig.network,
            rpcUrl: umbraConfig.rpcUrl,
            rpcSubscriptionsUrl: umbraConfig.rpcSubscriptionsUrl,
            indexerApiEndpoint: umbraConfig.indexerApiEndpoint,
          },
          {
            // HTTP polling for tx confirmation (see buildPollingForwarder).
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            transactionForwarder: getForwarder() as any,
            // Default is WebSocket account subscriptions for Arcium MPC callbacks.
            // Public devnet WS often drops computation-account updates, so withdraw
            // appears "stuck" on awaitComputation() until a 5 min safety timeout.
            // Polling getAccountInfo over HTTP matches our forwarder strategy.
            computationMonitor: getPollingComputationMonitor({
              rpcUrl: umbraConfig.rpcUrl,
            }),
          },
        );
      } catch (clientErr) {
        console.error("[umbra-client] getUmbraClient FAILED:", clientErr);
        throw clientErr;
      }
      console.log(`[umbra-client] ✔ client ready (${Date.now() - t0}ms)`, {
        address: client.signer.address,
        network: (client as { network?: string }).network,
      });

      if (cancelled) return;

      setState({
        status: "registering",
        client,
        registration: {
          confidential: false,
          anonymous: false,
          phase: "idle",
          message: "Checking Umbra registration…",
        },
      });

      try {
        await ensureUmbraFullRegistration(client, {
          onProgress: (message) => {
            if (cancelled) return;
            setState({
              status: "registering",
              client,
              registration: {
                confidential: false,
                anonymous: false,
                phase: registrationPhaseFromMessage(message),
                message,
              },
            });
          },
        });
      } catch (registrationErr) {
        if (cancelled) return;
        console.warn("[umbra-client] proactive Umbra registration failed:", registrationErr);
        setState({
          status: "ready",
          client,
          registration: {
            confidential: false,
            anonymous: false,
            phase: "failed",
            message: registrationErr instanceof Error
              ? registrationErr.message
              : String(registrationErr),
          },
        });
        return;
      }

      if (cancelled) return;

      setState({
        status: "ready",
        client,
        registration: {
          confidential: true,
          anonymous: true,
          phase: "complete",
          message: "Umbra registration ready.",
        },
      });
    })().catch((err) => {
      if (!cancelled) {
        console.error("[umbra-client] UmbraClientProvider setup error:", err);
        setState({
          status: "error",
          error: err instanceof Error ? err : new Error(String(err)),
        });
      }
    });

    return () => {
      cancelled = true;
    };
    // wallet reference is intentionally excluded — walletKey captures identity
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [walletKey]);

  return (
    <UmbraClientContext.Provider value={state}>
      {children}
    </UmbraClientContext.Provider>
  );
}

/** Returns the current Umbra client state for the connected wallet. */
export function useUmbraClientState(): UmbraClientState {
  return React.useContext(UmbraClientContext);
}

/**
 * Returns the ready Umbra client or null if not yet connected/registered.
 * Components can use this to conditionally enable Umbra operations.
 */
export function useUmbraClient(): IUmbraClient | null {
  const state = React.useContext(UmbraClientContext);
  return state.status === "ready" ? state.client : null;
}
