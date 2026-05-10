export type SolanaCluster = "mainnet-beta" | "devnet" | "testnet" | "localnet";
export type SwitchableSolanaCluster = "mainnet-beta" | "devnet";

const VALID_CLUSTERS: readonly SolanaCluster[] = [
  "mainnet-beta",
  "devnet",
  "testnet",
  "localnet",
];

export const SWITCHABLE_SOLANA_CLUSTERS: readonly SwitchableSolanaCluster[] = [
  "mainnet-beta",
  "devnet",
];

export const SOLANA_CLUSTER_OVERRIDE_STORAGE_KEY = "onyx:solana-cluster:v1";

const DEFAULT_RPC: Record<SolanaCluster, string> = {
  "mainnet-beta": "https://api.mainnet-beta.solana.com",
  devnet: "https://api.devnet.solana.com",
  testnet: "https://api.testnet.solana.com",
  localnet: "http://127.0.0.1:8899",
};

const DEFAULT_WS: Record<SolanaCluster, string> = {
  "mainnet-beta": "wss://api.mainnet-beta.solana.com",
  devnet: "wss://api.devnet.solana.com",
  testnet: "wss://api.testnet.solana.com",
  localnet: "ws://127.0.0.1:8900",
};

function clean(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function isHttpUrl(value: string | undefined): value is string {
  return !!value && (value.startsWith("http://") || value.startsWith("https://"));
}

function isWsUrl(value: string | undefined): value is string {
  return !!value && (value.startsWith("ws://") || value.startsWith("wss://"));
}

function isBrowser(): boolean {
  return typeof window !== "undefined" && typeof window.localStorage !== "undefined";
}

function parseCluster(value: string | undefined): SolanaCluster | null {
  return VALID_CLUSTERS.find((c) => c === value) ?? null;
}

export function isSwitchableSolanaCluster(
  value: string | undefined,
): value is SwitchableSolanaCluster {
  return SWITCHABLE_SOLANA_CLUSTERS.some((c) => c === value);
}

function readBrowserClusterOverride(): SwitchableSolanaCluster | null {
  if (!isBrowser()) return null;
  try {
    const value =
      window.localStorage.getItem(SOLANA_CLUSTER_OVERRIDE_STORAGE_KEY) ??
      undefined;
    return isSwitchableSolanaCluster(value) ? value : null;
  } catch {
    return null;
  }
}

export function setSolanaClusterOverride(cluster: SwitchableSolanaCluster): void {
  if (!isBrowser()) return;
  window.localStorage.setItem(SOLANA_CLUSTER_OVERRIDE_STORAGE_KEY, cluster);
}

export function clearSolanaClusterOverride(): void {
  if (!isBrowser()) return;
  window.localStorage.removeItem(SOLANA_CLUSTER_OVERRIDE_STORAGE_KEY);
}

export function getSolanaClusterLabel(cluster: SolanaCluster): string {
  switch (cluster) {
    case "mainnet-beta":
      return "Mainnet";
    case "devnet":
      return "Devnet";
    case "testnet":
      return "Testnet";
    case "localnet":
      return "Localnet";
  }
}

const rawEnvCluster = clean(process.env.NEXT_PUBLIC_SOLANA_CLUSTER) ?? "devnet";
const envCluster = parseCluster(rawEnvCluster);
if (!envCluster) {
  throw new Error(
    `Invalid NEXT_PUBLIC_SOLANA_CLUSTER "${rawEnvCluster}". Expected one of: ${VALID_CLUSTERS.join(", ")}.`,
  );
}

const browserClusterOverride = readBrowserClusterOverride();
const cluster = browserClusterOverride ?? envCluster;
const usingBrowserClusterOverride = browserClusterOverride !== null;

const envRpcByCluster: Partial<Record<SolanaCluster, string | undefined>> = {
  "mainnet-beta": clean(process.env.NEXT_PUBLIC_SOLANA_MAINNET_RPC_URL),
  devnet: clean(process.env.NEXT_PUBLIC_SOLANA_DEVNET_RPC_URL),
};

const envWsByCluster: Partial<Record<SolanaCluster, string | undefined>> = {
  "mainnet-beta": clean(process.env.NEXT_PUBLIC_SOLANA_MAINNET_WS_URL),
  devnet: clean(process.env.NEXT_PUBLIC_SOLANA_DEVNET_WS_URL),
};

const envRpcUrl =
  envRpcByCluster[cluster] ??
  (usingBrowserClusterOverride ? undefined : clean(process.env.NEXT_PUBLIC_SOLANA_RPC_URL));
const envWsUrl =
  envWsByCluster[cluster] ??
  (usingBrowserClusterOverride ? undefined : clean(process.env.NEXT_PUBLIC_SOLANA_WS_URL));

const rpcUrl = isHttpUrl(envRpcUrl) ? envRpcUrl : DEFAULT_RPC[cluster];
const wsUrl = isWsUrl(envWsUrl) ? envWsUrl : DEFAULT_WS[cluster];

if (envRpcUrl && envRpcUrl !== rpcUrl) {
  console.warn(
    `Ignoring NEXT_PUBLIC_SOLANA_RPC_URL "${envRpcUrl}": must start with http:// or https://. Using ${rpcUrl}.`,
  );
}
if (envWsUrl && envWsUrl !== wsUrl) {
  console.warn(
    `Ignoring NEXT_PUBLIC_SOLANA_WS_URL "${envWsUrl}": must start with ws:// or wss://. Using ${wsUrl}.`,
  );
}

export const solanaConfig = {
  cluster,
  rpcUrl,
  wsUrl,
  clusterLabel: getSolanaClusterLabel(cluster),
  isBrowserOverride: usingBrowserClusterOverride,
} as const;

export type SolanaConfig = typeof solanaConfig;

export const LAMPORTS_PER_SOL = 1_000_000_000n;
