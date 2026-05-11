export type SolanaCluster = "mainnet-beta" | "devnet" | "testnet" | "localnet";

const DEVNET_RPC = "https://api.devnet.solana.com";
const DEVNET_WS = "wss://api.devnet.solana.com";

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

const cluster: SolanaCluster = "devnet";
const envRpcUrl =
  clean(process.env.NEXT_PUBLIC_SOLANA_DEVNET_RPC_URL) ??
  clean(process.env.NEXT_PUBLIC_SOLANA_RPC_URL);
const envWsUrl =
  clean(process.env.NEXT_PUBLIC_SOLANA_DEVNET_WS_URL) ??
  clean(process.env.NEXT_PUBLIC_SOLANA_WS_URL);

const rpcUrl = isHttpUrl(envRpcUrl) ? envRpcUrl : DEVNET_RPC;
const wsUrl = isWsUrl(envWsUrl) ? envWsUrl : DEVNET_WS;

if (envRpcUrl && envRpcUrl !== rpcUrl) {
  console.warn(
    `Ignoring Solana RPC URL "${envRpcUrl}": must start with http:// or https://. Using ${rpcUrl}.`,
  );
}
if (envWsUrl && envWsUrl !== wsUrl) {
  console.warn(
    `Ignoring Solana WebSocket URL "${envWsUrl}": must start with ws:// or wss://. Using ${wsUrl}.`,
  );
}

export const solanaConfig: {
  cluster: SolanaCluster;
  rpcUrl: string;
  wsUrl: string;
} = {
  cluster,
  rpcUrl,
  wsUrl,
};

export type SolanaConfig = typeof solanaConfig;

export const LAMPORTS_PER_SOL = 1_000_000_000n;
