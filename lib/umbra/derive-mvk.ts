"use client";

import { getMasterViewingKeyDeriver, getUmbraClient } from "@umbra-privacy/sdk";

type IUmbraClient = Awaited<ReturnType<typeof getUmbraClient>>;

export type DeriveMvkResult = {
  /** Hex-encoded master viewing key. Share only through scoped audit access tokens. */
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
  const derive = getMasterViewingKeyDeriver({ client });
  const mvk = await derive();

  return { mvkHex: BigInt(mvk).toString(16).padStart(64, "0") };
}
