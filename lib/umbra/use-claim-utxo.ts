"use client";

import {
  getClaimableUtxoScannerFunction,
  getEncryptedBalanceQuerierFunction,
  getEncryptedBalanceToPublicBalanceDirectWithdrawerFunction,
  getReceiverClaimableUtxoToEncryptedBalanceClaimerFunction,
  getSelfClaimableUtxoToPublicBalanceClaimerFunction,
  getUmbraRelayer,
} from "@umbra-privacy/sdk";
import { isClaimUtxoError, isEncryptedWithdrawalError } from "@umbra-privacy/sdk/errors";
import type { Address } from "@solana/kit";
import type { U32 } from "@umbra-privacy/sdk/types";
import {
  getClaimReceiverClaimableUtxoIntoEncryptedBalanceProver,
  getClaimSelfClaimableUtxoIntoPublicBalanceProver,
} from "@umbra-privacy/web-zk-prover";
import { useWallet } from "@solana/wallet-adapter-react";
import * as React from "react";

import { solanaConfig } from "@/lib/solana/config";
import { umbraConfig } from "./config";
import {
  ensureUmbraFullRegistration,
  randomUmbraGenerationIndex,
  useUmbraClient,
} from "./client";
import { getShieldTokens } from "./tokens";
import type { ReceivedUtxoClaimState } from "./scanned-history";

export type ClaimOutcome = {
  receivedState?: ReceivedUtxoClaimState;
};

export type ClaimStatus =
  | "idle"
  | "scanning"
  | "proving"
  | "claiming"
  | "querying"
  | "withdrawing"
  | "success"
  | "error";

export type UseClaimUtxos = {
  claimAndWithdraw: () => Promise<ClaimOutcome>;
  status: ClaimStatus;
  progress: string | null;
  error: Error | null;
  claimedCount: number;
  withdrawnCount: number;
  /** Extra context after success (e.g. already-claimed + nothing to withdraw). */
  successHint: string | null;
  reset: () => void;
};

const TREES_TO_SCAN = solanaConfig.cluster === "mainnet-beta" ? 4 : 1;

// Devnet Arcium MPC can take several minutes. Give it up to 10 min before giving up.
const CLAIM_TIMEOUT_MS = 10 * 60 * 1000;
// Poll relayer every 5 s to avoid hammering the endpoint.
const CLAIM_POLL_INTERVAL_MS = 5_000;
const BALANCE_POLL_INTERVAL_MS = 5_000;
// Keep the withdraw-only check short. If Arcium has not exposed a shared
// encrypted balance yet, return a clear pending state instead of looking stuck.
const BALANCE_POLL_RETRY_MS = 30_000;
const BALANCE_QUERY_TIMEOUT_MS = 12_000;
// Max retries for stale Merkle proof re-fetch
const MAX_STALE_PROOF_RETRIES = 2;

type ReceiverClaimDeps = NonNullable<
  Parameters<typeof getReceiverClaimableUtxoToEncryptedBalanceClaimerFunction>[1]
>;
type SelfPublicClaimDeps = NonNullable<
  Parameters<typeof getSelfClaimableUtxoToPublicBalanceClaimerFunction>[1]
>;
type WithdrawDeps = NonNullable<
  Parameters<typeof getEncryptedBalanceToPublicBalanceDirectWithdrawerFunction>[1]
>;
type WithdrawAmount = Parameters<
  ReturnType<typeof getEncryptedBalanceToPublicBalanceDirectWithdrawerFunction>
>[2];
type EncryptedBalanceMap = Map<string, { state: string; balance?: bigint }>;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  message: string,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      reject(new Error(message));
    }, ms);

    promise
      .then((value) => {
        window.clearTimeout(timeout);
        resolve(value);
      })
      .catch((err) => {
        window.clearTimeout(timeout);
        reject(err);
      });
  });
}

/** UTXO was already claimed on-chain — safe to skip claim and try withdraw only. */
function isNullifierAlreadyBurntMessage(text: string): boolean {
  const t = text.toLowerCase();
  return (
    t.includes("nullifieralreadyburnt")
    || t.includes("nullifier already burnt")
    || t.includes("28004")
    || t.includes("0x6d64")
    || t.includes("custom program error: 0x6d64")
  );
}

function isNullifierAlreadyBurntError(err: unknown): boolean {
  if (!err) return false;
  if (err instanceof Error) return isNullifierAlreadyBurntMessage(err.message);
  return isNullifierAlreadyBurntMessage(String(err));
}

function getBatchMerkleProofFetcher(client: unknown): ReceiverClaimDeps["fetchBatchMerkleProof"] {
  const fetcher = (client as { fetchBatchMerkleProof?: unknown })
    .fetchBatchMerkleProof;
  if (typeof fetcher !== "function") {
    throw new Error(
      "Umbra client is missing fetchBatchMerkleProof. Check NEXT_PUBLIC_UMBRA_INDEXER_URL / indexerApiEndpoint.",
    );
  }
  return fetcher as ReceiverClaimDeps["fetchBatchMerkleProof"];
}

function claimProgressMessage(event: { status?: string; requestId?: string }): string {
  const suffix = event.requestId ? ` (${event.requestId.slice(0, 8)})` : "";
  switch (event.status) {
    case "received":
      return `Relayer received claim${suffix}…`;
    case "validating":
      return `Relayer validating claim${suffix}…`;
    case "offsets_reserved":
      return `Relayer reserved random offsets${suffix}…`;
    case "building_tx":
    case "tx_built":
      return `Relayer building claim transaction${suffix}…`;
    case "submitting":
    case "submitted":
      return `Claim transaction submitted${suffix}; waiting for Arcium callback…`;
    case "awaiting_callback":
      return `Waiting for Arcium callback${suffix}…`;
    case "callback_received":
    case "finalizing":
      return `Arcium callback received${suffix}; finalizing claim…`;
    case "completed":
      return `Claim completed${suffix}; checking encrypted balance…`;
    case "timed_out":
      return `Claim is still pending at the relayer${suffix}; you can retry Claim later.`;
    case "failed":
    case "refunded":
      return `Claim ${event.status}${suffix}.`;
    default:
      return `Claim status ${event.status ?? "pending"}${suffix}…`;
  }
}

type ClaimableScanner = ReturnType<typeof getClaimableUtxoScannerFunction>;
type ClaimableCollections = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  selfBurnable: any[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  receiverClaimable: any[];
};

async function scanAllClaimableUtxos(
  scanner: ClaimableScanner,
  onProgress: (message: string) => void,
): Promise<ClaimableCollections> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const selfBurnable: any[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const receiverClaimable: any[] = [];

  for (let treeIdx = 0; treeIdx < TREES_TO_SCAN; treeIdx++) {
    onProgress(
      TREES_TO_SCAN > 1
        ? `Scanning tree ${treeIdx + 1} of ${TREES_TO_SCAN}…`
        : "Scanning for unclaimed UTXOs…",
    );
    const result = await scanner(
      BigInt(treeIdx) as unknown as U32,
      0n as unknown as U32,
    );

    if (result.selfBurnable?.length) selfBurnable.push(...result.selfBurnable);
    if (result.received?.length) receiverClaimable.push(...result.received);
    if (result.publicReceived?.length) {
      receiverClaimable.push(...result.publicReceived);
    }
  }

  return { selfBurnable, receiverClaimable };
}

type ClaimBatchLike = {
  readonly requestId?: string;
  readonly status?: string;
  readonly txSignature?: string;
  readonly callbackSignature?: string;
  readonly failureReason?: string | null;
  readonly utxoIds?: readonly string[];
};

type ClaimResultStats = {
  completedUtxos: number;
  pendingUtxos: number;
  failedUtxos: number;
  failureMessages: string[];
  submitted: boolean;
};

function claimBatchesFromResult(result: unknown): ClaimBatchLike[] {
  if (!result || typeof result !== "object") return [];
  const maybeBatches = (result as { batches?: unknown }).batches;
  if (maybeBatches instanceof Map) {
    return Array.from(maybeBatches.values()) as ClaimBatchLike[];
  }
  if (maybeBatches && typeof maybeBatches === "object") {
    return Object.values(maybeBatches) as ClaimBatchLike[];
  }
  return [];
}

function summarizeClaimResult(
  result: unknown,
  fallbackUtxoCount: number,
): ClaimResultStats {
  const legacySignatures = (result as { signatures?: Record<string, string[]> } | null)
    ?.signatures;
  if (legacySignatures) {
    const sigCount = Object.values(legacySignatures).flat().length;
    return {
      completedUtxos: sigCount > 0 ? fallbackUtxoCount : 0,
      pendingUtxos: 0,
      failedUtxos: 0,
      failureMessages: [],
      submitted: sigCount > 0,
    };
  }

  const batches = claimBatchesFromResult(result);
  if (batches.length === 0) {
    return {
      completedUtxos: 0,
      pendingUtxos: 0,
      failedUtxos: 0,
      failureMessages: [],
      submitted: false,
    };
  }

  let completedUtxos = 0;
  let pendingUtxos = 0;
  let failedUtxos = 0;
  const failureMessages: string[] = [];
  const hasExplicitUtxoIds = batches.some((batch) => Array.isArray(batch.utxoIds));

  for (const batch of batches) {
    const count = batch.utxoIds?.length ?? 1;
    const status = batch.status ?? "submitted";
    if (status === "completed") {
      completedUtxos += count;
    } else if (status === "failed" || status === "refunded") {
      failedUtxos += count;
      failureMessages.push(
        `${batch.requestId ?? "batch"} ${status}${batch.failureReason ? `: ${batch.failureReason}` : ""}`,
      );
    } else {
      // Includes relayer in-flight states and timed_out. A timeout can still
      // have a landed nullifier/callback, so continue to the balance check.
      pendingUtxos += count;
    }
  }

  if (!hasExplicitUtxoIds && completedUtxos + pendingUtxos > 0) {
    const totalActive = completedUtxos + pendingUtxos;
    if (fallbackUtxoCount > totalActive) {
      if (completedUtxos > 0) completedUtxos = fallbackUtxoCount - pendingUtxos;
      else pendingUtxos = fallbackUtxoCount;
    }
  }

  return {
    completedUtxos,
    pendingUtxos,
    failedUtxos,
    failureMessages,
    submitted: completedUtxos + pendingUtxos > 0,
  };
}

function onlyNullifierAlreadyBurnt(messages: string[]): boolean {
  return messages.length > 0 && messages.every(isNullifierAlreadyBurntMessage);
}

/**
 * Full recipient claim flow per the Umbra SDK docs:
 *
 * 1. Scan mixer trees for all claimable UTXOs (selfBurnable + received + publicReceived).
 * 2. Claim self-burnable UTXOs → public wallet via getSelfClaimableUtxoToPublicBalanceClaimerFunction.
 * 3. Claim receiver-claimable UTXOs → encrypted balance via getReceiverClaimableUtxoToEncryptedBalanceClaimerFunction.
 * 4. Poll encrypted balance until Arcium MPC settles.
 * 5. Withdraw each settled encrypted token balance → public wallet.
 *
 * Error handling follows the documented isClaimUtxoError / err.stage pattern:
 * - "transaction-validate": stale Merkle proof → re-fetch and retry (up to MAX_STALE_PROOF_RETRIES).
 * - "transaction-send": confirmation timeout → warn user and continue (nullifier may be burnt).
 * - Other stages: rethrow to surface in UI.
 */
export function useClaimUtxos(): UseClaimUtxos {
  const client = useUmbraClient();
  const wallet = useWallet();

  const [status, setStatus] = React.useState<ClaimStatus>("idle");
  const [progress, setProgress] = React.useState<string | null>(null);
  const [error, setError] = React.useState<Error | null>(null);
  const [claimedCount, setClaimedCount] = React.useState(0);
  const [withdrawnCount, setWithdrawnCount] = React.useState(0);
  const [successHint, setSuccessHint] = React.useState<string | null>(null);

  const inflightRef = React.useRef<Promise<ClaimOutcome> | null>(null);

  const claimAndWithdraw = React.useCallback(async (): Promise<ClaimOutcome> => {
    if (inflightRef.current) return inflightRef.current;

    const run = (async () => {
      if (!client) throw new Error("Umbra client not ready.");
      if (!wallet.publicKey) throw new Error("Wallet not connected.");
      const walletAddress = wallet.publicKey.toBase58() as Address;

      try {
        setSuccessHint(null);

        // ── 1. Scan ──────────────────────────────────────────────────────────
        setStatus("scanning");
        setError(null);
        setProgress("Preparing Umbra account…");
        await ensureUmbraFullRegistration(client, { onProgress: setProgress });
        setProgress("Scanning for unclaimed UTXOs…");

        const scanner = getClaimableUtxoScannerFunction({ client });
        let { selfBurnable: allSelfBurnable, receiverClaimable: allReceiverClaimable } =
          await scanAllClaimableUtxos(scanner, setProgress);

        const totalUtxos = allSelfBurnable.length + allReceiverClaimable.length;
        let skipClaimBecauseAlreadySpent = false;
        let ranSuccessfulFreshClaim = false;
        let queuedReceiverClaim = false;
        let totalClaimedCount = 0;
        const claimWarnings: string[] = [];

        // ── 2a. Claim self-burnable UTXOs → public wallet ───────────────────
        if (allSelfBurnable.length > 0) {
          setStatus("proving");
          setProgress(
            `Generating ZK proof for ${allSelfBurnable.length} self-claimable UTXO${allSelfBurnable.length !== 1 ? "s" : ""}…`,
          );

          const selfProver = getClaimSelfClaimableUtxoIntoPublicBalanceProver();
          const selfRelayer = getUmbraRelayer({ apiEndpoint: umbraConfig.relayerApiEndpoint });
          const selfClaimDeps = {
            fetchBatchMerkleProof: getBatchMerkleProofFetcher(client),
            zkProver: selfProver,
            relayer: selfRelayer,
            awaitCompletion: true,
            timeoutMs: CLAIM_TIMEOUT_MS,
            pollingIntervalMs: CLAIM_POLL_INTERVAL_MS,
            onProgress: (event: { status?: string; requestId?: string }) => {
              setProgress(claimProgressMessage(event));
            },
          } as unknown as SelfPublicClaimDeps;

          const selfClaim = getSelfClaimableUtxoToPublicBalanceClaimerFunction(
            { client, generationIndex: randomUmbraGenerationIndex() },
            selfClaimDeps,
          );

          setStatus("claiming");
          setProgress(`Submitting ${allSelfBurnable.length} self-claimable UTXO${allSelfBurnable.length !== 1 ? "s" : ""} to relayer…`);

          let selfClaimResult: unknown = null;
          let staleRetries = 0;

          while (staleRetries <= MAX_STALE_PROOF_RETRIES) {
            try {
              selfClaimResult = await selfClaim(allSelfBurnable);
              break; // success
            } catch (selfErr) {
              if (isNullifierAlreadyBurntError(selfErr)) {
                skipClaimBecauseAlreadySpent = true;
                setProgress("Self-claimable UTXO already claimed — checking wallet balance…");
                console.info("[umbra] self-claim skipped: nullifier already burnt");
                break;
              }

              if (isClaimUtxoError(selfErr)) {
                switch (selfErr.stage) {
                  case "transaction-validate":
                    // Stale Merkle proof — re-fetch and retry
                    if (staleRetries < MAX_STALE_PROOF_RETRIES) {
                      staleRetries++;
                      setProgress(`Merkle proof stale — re-fetching and retrying (attempt ${staleRetries}/${MAX_STALE_PROOF_RETRIES})…`);
                      console.warn("[umbra] self-claim: stale Merkle proof — re-fetching", selfErr.message);
                      const fresh = await scanAllClaimableUtxos(scanner, setProgress);
                      allSelfBurnable = fresh.selfBurnable;
                      if (allSelfBurnable.length === 0) {
                        setProgress("No fresh self-claimable UTXOs found after re-scan.");
                        break;
                      }
                      await sleep(1_000);
                      continue;
                    }
                    throw selfErr;

                  case "transaction-send":
                    // Confirmation timeout — nullifier may already be burnt; continue safely
                    console.warn("[umbra] self-claim: confirmation timeout — check on-chain before retrying", selfErr.message);
                    setProgress("Confirmation timed out — funds may have been received. Continuing…");
                    claimWarnings.push("A self-claim confirmation timed out. If funds do not appear, retry Claim after a minute.");
                    break;

                  default:
                    throw selfErr;
                }
                break;
              }
              throw selfErr;
            }
          }

          const selfStats = summarizeClaimResult(
            selfClaimResult,
            allSelfBurnable.length,
          );
          if (selfStats.submitted) {
            console.info("[umbra] self-claim result:", selfClaimResult);
            totalClaimedCount += selfStats.completedUtxos + selfStats.pendingUtxos;
            ranSuccessfulFreshClaim = true;
          }
          if (selfStats.failureMessages.length) {
            claimWarnings.push(`Self-claim warning: ${selfStats.failureMessages.join(" · ")}`);
          }
        }

        // ── 2b. Claim receiver-claimable UTXOs → encrypted balance ───────────
        if (allReceiverClaimable.length > 0) {
          setStatus("proving");
          setProgress(
            `Generating ZK proof for ${allReceiverClaimable.length} received UTXO${allReceiverClaimable.length !== 1 ? "s" : ""}…`,
          );

          setProgress("Umbra account ready for encrypted balance claim…");

          const receiverProver = getClaimReceiverClaimableUtxoIntoEncryptedBalanceProver();
          const receiverRelayer = getUmbraRelayer({ apiEndpoint: umbraConfig.relayerApiEndpoint });
          const receiverClaimDeps = {
            fetchBatchMerkleProof: getBatchMerkleProofFetcher(client),
            zkProver: receiverProver,
            relayer: receiverRelayer,
            awaitCompletion: true,
            timeoutMs: CLAIM_TIMEOUT_MS,
            pollingIntervalMs: CLAIM_POLL_INTERVAL_MS,
            onProgress: (event: { status?: string; requestId?: string }) => {
              setProgress(claimProgressMessage(event));
            },
          } as unknown as ReceiverClaimDeps;

          const receiverClaim = getReceiverClaimableUtxoToEncryptedBalanceClaimerFunction(
            { client, generationIndex: randomUmbraGenerationIndex() },
            receiverClaimDeps,
          );

          setStatus("claiming");
          setProgress("Submitting received UTXOs claim to relayer…");

          let staleRetries = 0;
          let receiverClaimResult: unknown = null;

          while (staleRetries <= MAX_STALE_PROOF_RETRIES) {
            try {
              receiverClaimResult = await receiverClaim(allReceiverClaimable);
              break; // success
            } catch (recErr) {
              if (isNullifierAlreadyBurntError(recErr)) {
                skipClaimBecauseAlreadySpent = true;
                setProgress(
                  "Already claimed on-chain — checking your encrypted balance and moving to wallet…",
                );
                console.info("[umbra] receiver-claim skipped: nullifier already burnt");
                break;
              }

              if (isClaimUtxoError(recErr)) {
                switch (recErr.stage) {
                  case "transaction-validate":
                    // Stale Merkle proof — re-fetch and retry
                    if (staleRetries < MAX_STALE_PROOF_RETRIES) {
                      staleRetries++;
                      setProgress(`Merkle proof stale — re-fetching and retrying (attempt ${staleRetries}/${MAX_STALE_PROOF_RETRIES})…`);
                      console.warn("[umbra] receiver-claim: stale Merkle proof — re-fetching", recErr.message);
                      const fresh = await scanAllClaimableUtxos(scanner, setProgress);
                      allReceiverClaimable = fresh.receiverClaimable;
                      if (allReceiverClaimable.length === 0) {
                        setProgress("No fresh received UTXOs found after re-scan.");
                        break;
                      }
                      await sleep(1_000);
                      continue;
                    }
                    throw recErr;

                  case "transaction-send":
                    // Confirmation timeout — nullifier may already be burnt; continue safely
                    console.warn("[umbra] receiver-claim: confirmation timeout — check on-chain before retrying", recErr.message);
                    setProgress("Confirmation timed out — funds may be settling. Continuing to check balance…");
                    ranSuccessfulFreshClaim = true;
                    claimWarnings.push("The relayer confirmation timed out. I will keep checking the encrypted balance before withdrawing.");
                    break;

                  case "zk-proof-generation":
                    console.error("[umbra] receiver-claim: ZK proof generation failed", recErr.message);
                    throw new Error(`Failed to generate ZK proof. Please try again. (${recErr.message})`);

                  case "transaction-sign":
                    throw new Error("Claim cancelled — you rejected the transaction.");

                  default:
                    throw recErr;
                }
                break;
              }
              throw recErr;
            }
          }

          const receiverStats = summarizeClaimResult(
            receiverClaimResult,
            allReceiverClaimable.length,
          );
          if (receiverStats.submitted && !skipClaimBecauseAlreadySpent) {
            console.info("[umbra] receiver-claim result:", receiverClaimResult);
            totalClaimedCount += receiverStats.completedUtxos + receiverStats.pendingUtxos;
            ranSuccessfulFreshClaim = true;
            queuedReceiverClaim = receiverStats.pendingUtxos > 0;
            if (queuedReceiverClaim) {
              claimWarnings.push(
                "Receiver claim is still pending at the relayer or waiting for Arcium settlement.",
              );
            }
          }
          if (onlyNullifierAlreadyBurnt(receiverStats.failureMessages)) {
            skipClaimBecauseAlreadySpent = true;
            setProgress(
              "Already claimed on-chain — checking your encrypted balance and moving to wallet…",
            );
          } else if (receiverStats.failureMessages.length) {
            claimWarnings.push(`Receiver-claim warning: ${receiverStats.failureMessages.join(" · ")}`);
          }
        }

        setClaimedCount(skipClaimBecauseAlreadySpent ? 0 : totalClaimedCount);
        let outcome: ClaimOutcome = {};

        if (queuedReceiverClaim) {
          setWithdrawnCount(0);
          setSuccessHint(
            claimWarnings.length
              ? claimWarnings.join(" ")
              : "Receiver claim was accepted by the relayer and is waiting for Arcium settlement. Click Claim again in a few minutes to withdraw once the encrypted balance is visible.",
          );
          setStatus("success");
          setProgress(null);
          return { receivedState: "processing" as const };
        }

        if (totalUtxos === 0) {
          setClaimedCount(0);
          setProgress("No UTXOs left to claim — checking encrypted pool for withdrawable balance…");
        }

        // ── 3. Query encrypted balance ──────────────────────────────────────
        // Receiver claims first land in encrypted balance. A later retry often
        // scans zero UTXOs because the relayer already burned nullifiers, but
        // the settled encrypted balance still needs withdrawing.
        const needEncryptedCheck =
          allReceiverClaimable.length > 0
          || skipClaimBecauseAlreadySpent
          || totalUtxos === 0;

        if (needEncryptedCheck) {
          setStatus("querying");
          const tokens = getShieldTokens();
          const mints = tokens.map((t) => t.mint as Address);
          const querier = getEncryptedBalanceQuerierFunction({ client });
          const queryEncryptedBalance = () =>
            withTimeout(
              querier(mints) as Promise<EncryptedBalanceMap>,
              BALANCE_QUERY_TIMEOUT_MS,
              "Encrypted balance check timed out. Arcium may still be settling this claim.",
            );
          const hasClaimSettlementContext =
            allReceiverClaimable.length > 0
            || skipClaimBecauseAlreadySpent
            || ranSuccessfulFreshClaim;

          const maxPollMs = hasClaimSettlementContext ? BALANCE_POLL_RETRY_MS : 0;

          const pollStart = Date.now();
          let balanceQueryTimedOut = false;
          let balanceMap: EncryptedBalanceMap = new Map();
          setProgress(
            hasClaimSettlementContext
              ? "Checking encrypted balance for settled funds…"
              : "Checking encrypted pool for funds…",
          );
          try {
            balanceMap = await queryEncryptedBalance();
          } catch (balanceErr) {
            balanceQueryTimedOut = true;
            console.warn("[umbra] encrypted balance query timed out/failed:", balanceErr);
          }

          function hasWithdrawableBalance(m: EncryptedBalanceMap): boolean {
            for (const mint of mints) {
              const e = m.get(mint);
              if (e?.state === "shared" && e.balance && e.balance > 0n) return true;
            }
            return false;
          }

          while (
            maxPollMs > 0
            && Date.now() - pollStart < maxPollMs
            && !hasWithdrawableBalance(balanceMap)
            && !balanceQueryTimedOut
          ) {
            const elapsedMs = Date.now() - pollStart;
            const remainingSeconds = Math.max(
              0,
              Math.ceil((maxPollMs - elapsedMs) / 1000),
            );
            setProgress(
              queuedReceiverClaim
                ? `Claim queued — waiting for Arcium settlement (${remainingSeconds}s check)…`
                : ranSuccessfulFreshClaim
                  ? `Claim settled — waiting for encrypted balance (${remainingSeconds}s check)…`
                  : hasClaimSettlementContext
                    ? `Checking encrypted balance for settled funds (${remainingSeconds}s check)…`
                    : `Checking encrypted pool for funds (${remainingSeconds}s check)…`,
            );
            await sleep(BALANCE_POLL_INTERVAL_MS);
            try {
              balanceMap = await queryEncryptedBalance();
            } catch (balanceErr) {
              balanceQueryTimedOut = true;
              console.warn("[umbra] encrypted balance query timed out/failed:", balanceErr);
            }
          }

          // ── 4. Withdraw each non-zero shared balance → public wallet ───────
          // The withdrawer submits a queue_computation tx (immediate) then waits for
          // the Arcium MPC callback tx. On devnet the MPC can take >10 min, so
          // `transaction-send` timeout is non-fatal: the queue was confirmed and
          // Arcium WILL process it. Treat it as "queued" not "failed".
          setStatus("withdrawing");
          const withdrawDeps = {
            arcium: {
              awaitComputationFinalization: false,
            },
          } as unknown as WithdrawDeps;
          const withdrawer = getEncryptedBalanceToPublicBalanceDirectWithdrawerFunction(
            { client },
            withdrawDeps,
          );
          const withdrawCount = 0;
          let withdrawQueued = 0; // confirmed queue_computation but MPC callback still pending
          const withdrawErrors: string[] = [];

          for (const token of tokens) {
            const entry = balanceMap.get(token.mint);
            if (entry?.state === "shared" && entry.balance && entry.balance > 0n) {
              setProgress(
                `Withdrawing ${token.id} to wallet — queueing Arcium MPC computation…`,
              );
              try {
                const withdrawResult = await withdrawer(
                  walletAddress,
                  token.mint as Address,
                  entry.balance as WithdrawAmount,
                );
                withdrawQueued++;
                console.info(`[umbra] withdraw ${token.id} queued:`, withdrawResult);
              } catch (withdrawErr) {
                if (
                  isEncryptedWithdrawalError(withdrawErr)
                  && withdrawErr.stage === "transaction-send"
                  && /sig:/i.test(withdrawErr.message)
                ) {
                  withdrawQueued++;
                  console.info(
                    `[umbra] withdraw ${token.id}: queue transaction timed out after broadcast; treating as pending`,
                    withdrawErr.message,
                  );
                  continue;
                }
                const msg =
                  withdrawErr instanceof Error ? withdrawErr.message : String(withdrawErr);
                withdrawErrors.push(`${token.id}: ${msg}`);
                console.warn(`[umbra] withdraw ${token.id} failed:`, withdrawErr);
              }
            }
          }

          // withdrawn count already set above before successHint

          const hints: string[] = [];

          if (withdrawQueued === 0) {
            hints.push(...claimWarnings);
          }

          if (withdrawQueued > 0 && withdrawErrors.length === 0) {
            hints.push(
              `Withdrawal queued for Arcium MPC — your ${withdrawQueued > 1 ? `${withdrawQueued} token withdrawals have` : "token withdrawal has"} been submitted. ` +
                `Funds will arrive in your wallet once Arcium processes the computation (usually a few minutes). ` +
                `You can close this tab safely.`,
            );
          }
          if (withdrawErrors.length) {
            hints.push(
              `Withdraw failed: ${withdrawErrors.join(" · ")} ` +
                `Funds may still be in your Umbra encrypted balance. Click Claim again to retry withdraw only.`,
            );
          }
          if (
            ranSuccessfulFreshClaim
            && withdrawCount === 0
            && withdrawQueued === 0
            && !hasWithdrawableBalance(balanceMap)
            && withdrawErrors.length === 0
          ) {
            hints.push(
              balanceQueryTimedOut
                ? "Claim was submitted, but the encrypted balance check timed out. Arcium settlement may still be pending; click Claim again in a minute to withdraw."
                : queuedReceiverClaim
                  ? "Claim is queued but no encrypted balance is visible yet. Arcium can lag on devnet/mainnet congestion; click Claim again later to withdraw once it lands."
                  : "Claim finished but encrypted balance is still zero after the short check. Arcium on devnet can lag — click Claim again in a few minutes.",
            );
          }
          if (
            skipClaimBecauseAlreadySpent
            && withdrawCount === 0
            && withdrawQueued === 0
            && withdrawErrors.length === 0
          ) {
            hints.push(
              hasWithdrawableBalance(balanceMap)
                ? "This payment was already claimed on-chain. If the list still shows Pending claim, tap Reset cache then Sync."
                : balanceQueryTimedOut
                  ? "This payment was already processed on-chain, but the encrypted balance check timed out. Wait for Arcium settlement and click Claim again."
                  : "This payment was already processed on-chain, but no withdrawable encrypted balance is visible yet. Wait for Arcium settlement and click Claim again.",
            );
          }
          if (
            balanceQueryTimedOut
            && hints.length === 0
            && withdrawCount === 0
            && withdrawQueued === 0
            && withdrawErrors.length === 0
          ) {
            hints.push(
              "Could not finish checking the encrypted pool. Click Claim again to retry the withdraw-only check.",
            );
          }
          if (
            totalUtxos === 0
            && !hasClaimSettlementContext
            && !balanceQueryTimedOut
            && withdrawCount === 0
            && withdrawQueued === 0
            && !hasWithdrawableBalance(balanceMap)
          ) {
            hints.push("No shielded balance to withdraw and no UTXOs to claim.");
          }

          setWithdrawnCount(withdrawCount + withdrawQueued); // count queued as "claimed" for UI
          setSuccessHint(hints.length ? hints.join(" ") : null);

          const receivedState: ReceivedUtxoClaimState | undefined =
            withdrawQueued > 0
              ? "withdrawal_queued"
              : ranSuccessfulFreshClaim || skipClaimBecauseAlreadySpent
                ? "processing"
                : undefined;
          outcome = receivedState ? { receivedState } : {};
        } else {
          // Self-burnable only — tokens go directly to ATA, no encrypted balance step needed.
          const hints: string[] = [];
          hints.push(...claimWarnings);
          if (skipClaimBecauseAlreadySpent) {
            hints.push(
              "This payment was already claimed on-chain. If the list still shows Pending claim, tap Reset cache then Sync.",
            );
          }
          setSuccessHint(hints.length ? hints.join(" ") : null);
          setWithdrawnCount(0);
        }

        setStatus("success");
        setProgress(null);
        return outcome;
      } catch (err) {
        setSuccessHint(null);
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
  }, [client, wallet.publicKey]);

  const reset = React.useCallback(() => {
    setStatus("idle");
    setError(null);
    setClaimedCount(0);
    setWithdrawnCount(0);
    setProgress(null);
    setSuccessHint(null);
  }, []);

  return {
    claimAndWithdraw,
    status,
    progress,
    error,
    claimedCount,
    withdrawnCount,
    successHint,
    reset,
  };
}
