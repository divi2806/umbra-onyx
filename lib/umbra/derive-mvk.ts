"use client";

import { getUmbraClient } from "@umbra-privacy/sdk";

type IUmbraClient = Awaited<ReturnType<typeof getUmbraClient>>;

export type DeriveMvkResult = {
  /** Hex-encoded master viewing key. Share with auditors for compliance. */
  mvkHex: string;
};

/**
 * Derives the Master Viewing Key (MVK) for the connected wallet via the
 * Umbra client. The MVK is the root of Umbra's hierarchical viewing key
 * system: MVK → Mint → Yearly → Monthly → Daily.
 *
 * No additional wallet prompt is needed if the client is already initialised
 * (the master seed was derived during getUmbraClient via UMBRA_MESSAGE_TO_SIGN).
 */
export async function deriveMvk(client: IUmbraClient): Promise<DeriveMvkResult> {
  // Build the KeyStorageContext the generator function requires.
  const ctx = {
    signerAddress: client.signer.address as string,
    domainSeparator: "MasterViewingKey/0",
    network: client.network,
    protocolVersion: client.versions.protocol().version,
    algorithmVersion: client.versions.algorithm().version,
    schemeVersion: client.versions.scheme().version,
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mvk = await client.masterViewingKey.generate(ctx as any);

  // MasterViewingKey is a branded Uint8Array-like value.
  const bytes = mvk as unknown as Uint8Array;
  const mvkHex = Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  return { mvkHex };
}
