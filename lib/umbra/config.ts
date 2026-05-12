import { solanaConfig } from "@/lib/solana/config";

const DEVNET_INDEXER = "https://utxo-indexer.api-devnet.umbraprivacy.com";
const DEVNET_RELAYER = "https://relayer.api-devnet.umbraprivacy.com";

export const umbraConfig = {
  network: "devnet",
  indexerApiEndpoint:
    process.env.NEXT_PUBLIC_UMBRA_INDEXER_URL ?? DEVNET_INDEXER,
  relayerApiEndpoint:
    process.env.NEXT_PUBLIC_UMBRA_RELAYER_URL ?? DEVNET_RELAYER,
  rpcUrl: solanaConfig.rpcUrl,
  rpcSubscriptionsUrl: solanaConfig.wsUrl,
} as const;

export type UmbraNetwork = (typeof umbraConfig)["network"];
