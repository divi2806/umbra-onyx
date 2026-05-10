import { solanaConfig, type SolanaCluster } from "@/lib/solana/config";

// Umbra network name ← Solana cluster name
const CLUSTER_TO_NETWORK: Partial<Record<SolanaCluster, "mainnet" | "devnet" | "localnet">> = {
  "mainnet-beta": "mainnet",
  devnet: "devnet",
  localnet: "localnet",
};

type UmbraClusterConfig = {
  network: "mainnet" | "devnet" | "localnet";
  indexerApiEndpoint: string;
  relayerApiEndpoint: string;
};

const CLUSTER_CONFIG: Partial<Record<SolanaCluster, UmbraClusterConfig>> = {
  "mainnet-beta": {
    network: "mainnet",
    indexerApiEndpoint: "https://utxo-indexer.api.umbraprivacy.com",
    relayerApiEndpoint: "https://relayer.api.umbraprivacy.com",
  },
  devnet: {
    network: "devnet",
    indexerApiEndpoint: "https://utxo-indexer.api-devnet.umbraprivacy.com",
    relayerApiEndpoint: "https://relayer.api-devnet.umbraprivacy.com",
  },
};

const fromCluster = CLUSTER_CONFIG[solanaConfig.cluster];
if (!fromCluster) {
  throw new Error(
    `Umbra is not configured for cluster "${solanaConfig.cluster}". ` +
      `Set NEXT_PUBLIC_SOLANA_CLUSTER to "mainnet-beta" or "devnet".`,
  );
}

export const umbraConfig = {
  network: CLUSTER_TO_NETWORK[solanaConfig.cluster] ?? "devnet",
  indexerApiEndpoint:
    process.env.NEXT_PUBLIC_UMBRA_INDEXER_URL ?? fromCluster.indexerApiEndpoint,
  relayerApiEndpoint:
    process.env.NEXT_PUBLIC_UMBRA_RELAYER_URL ?? fromCluster.relayerApiEndpoint,
  rpcUrl: solanaConfig.rpcUrl,
  rpcSubscriptionsUrl: solanaConfig.wsUrl,
} as const;

export type UmbraNetwork = (typeof umbraConfig)["network"];
