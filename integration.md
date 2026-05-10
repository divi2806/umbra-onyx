# Onyx Umbra Integration

This document explains how Onyx integrates the Umbra SDK and how the main user flows map to Umbra protocol operations.

## Integration Goals

Onyx uses Umbra to provide non-custodial private payments on Solana:

- Sender pays from a connected Solana wallet.
- Onyx creates a receiver-claimable Umbra UTXO.
- Receiver scans Umbra trees for incoming UTXOs.
- Receiver claims into Umbra encrypted balance.
- Receiver withdraws back to a public wallet when ready.
- Wallet holder can issue a read-only audit access token for a date range.

No Onyx server custodies funds or private keys.

## Packages

```json
{
  "@umbra-privacy/sdk": "^3.0.0",
  "@umbra-privacy/web-zk-prover": "^2.0.1"
}
```

The SDK reference for this repository is `llms.txt`.

## Network Mapping

Onyx maps Solana clusters to Umbra networks in `lib/umbra/config.ts`.

| Solana cluster | Umbra network | Indexer | Relayer |
|---|---|---|---|
| `mainnet-beta` | `mainnet` | `https://utxo-indexer.api.umbraprivacy.com` | `https://relayer.api.umbraprivacy.com` |
| `devnet` | `devnet` | `https://utxo-indexer.api-devnet.umbraprivacy.com` | `https://relayer.api-devnet.umbraprivacy.com` |

Users switch networks with the header selector. The selected cluster is saved in `localStorage` under `onyx:solana-cluster:v1`, then the app reloads so all SDK clients and local caches are rebuilt for that network.

## Wallet And Client Setup

`lib/solana/providers.tsx` creates the Solana wallet and connection providers.

`lib/umbra/client.tsx` creates the Umbra client after a wallet connects:

- Converts wallet adapter methods to Umbra's signer interface.
- Calls `getUmbraClient`.
- Supplies RPC, WebSocket, and indexer endpoints.
- Uses a custom HTTP polling transaction forwarder.
- Uses `getPollingComputationMonitor` for Arcium callback polling.
- Proactively runs full Umbra registration.

Registration calls `getUserRegistrationFunction` with `getUserRegistrationProver`.

Onyx requires both:

- confidential registration
- anonymous registration

The anonymous active flag must be set before send, invoice, claim, and audit-key flows proceed.

## Send Flow

Primary files:

- `lib/umbra/umbra-send-core.ts`
- `lib/umbra/use-umbra-send.ts`
- `app/(app)/pay/page.tsx`
- `components/team/due-run-dialog.tsx`

Flow:

1. Sender connects wallet.
2. Onyx ensures sender Umbra registration.
3. Onyx verifies the receiver is Umbra-ready.
4. Onyx converts amount to base units.
5. Onyx calls `getPublicBalanceToReceiverClaimableUtxoCreatorFunction`.
6. Browser prover `getCreateReceiverClaimableUtxoFromPublicBalanceProver` generates the ZK proof.
7. Onyx passes a fresh random generation index to avoid duplicate offset errors.
8. Successful transaction metadata is stored locally for the sender history.

The created UTXO is receiver-claimable. The receiver must later scan and claim it.

## Invoice Flow

Primary files:

- `app/(app)/invoice/page.tsx`
- `app/claim/page.tsx`
- `lib/umbra/invoice.ts`

Flow:

1. Receiver connects wallet on `/invoice`.
2. Onyx ensures receiver Umbra registration before creating an invoice.
3. Onyx stores the invoice locally and creates a `/claim?v=...` link.
4. Payer opens the link, connects wallet, and pays through the same Umbra send path.

Invoice links are payment requests, not custody objects. Funds move only when a payer signs the Umbra send transaction.

## Received Scan, Claim, And Withdraw Flow

Primary files:

- `lib/umbra/use-scanned-history.ts`
- `lib/umbra/use-claim-utxo.ts`
- `lib/umbra/scanned-history.ts`
- `app/(app)/history/page.tsx`

Flow:

1. Receiver opens History and scans for UTXOs with `getClaimableUtxoScannerFunction`.
2. Onyx includes both `received` and `publicReceived` results.
3. Matching rows are saved in local storage by wallet and cluster.
4. Claim uses `getReceiverClaimableUtxoToEncryptedBalanceClaimerFunction`.
5. Claim dependencies include ZK prover, relayer, Merkle proof fetcher, and fresh random generation index.
6. Claimed funds land in Umbra encrypted balance.
7. Withdraw uses `getEncryptedBalanceToPublicBalanceDirectWithdrawerFunction`.
8. Arcium callback completion can lag, so Onyx shows queued and pending settlement states instead of blocking indefinitely.

Known operational behavior:

- `NullifierAlreadyBurnt` means the UTXO was already processed.
- Arcium MPC settlement can lag on devnet and mainnet.
- Local claim state is retained so stale scanner rows do not keep showing as unclaimed.

## Audit Access Key Flow

Primary files:

- `app/(app)/compliance/page.tsx`
- `app/audit/page.tsx`
- `lib/umbra/derive-mvk.ts`
- `lib/umbra/viewing-keys.ts`

The UI calls this an **Audit access key**. The technical mechanism is an Umbra viewing-key-derived token plus a scoped snapshot of synced received UTXOs.

Wallet holder steps:

1. Sync received payments on `/history`.
2. Open `/compliance`.
3. Enter an auditor label and date range.
4. Generate the audit access key.
5. Share the token with the auditor.

Auditor steps:

1. Open `/audit`.
2. Paste the token.
3. Run the review.
4. Inspect date-scoped rows and download CSV.

Security properties:

- The token is read-only.
- It cannot sign, spend, claim, or withdraw.
- It reveals only the scoped snapshot included in the token.
- Archiving a key removes the issuer's local record, but already-shared snapshot tokens still exist wherever they were sent.

## Token Support

`lib/umbra/tokens.ts` is the current app token registry.

| Network | Tokens in app |
|---|---|
| Mainnet | SOL/wSOL, USDC, USDT, UMBRA |
| Devnet | SOL/wSOL |

All amounts are converted to base units before Umbra SDK calls.

## Error Handling

The integration intentionally keeps Umbra flows SDK-aligned and direct. Important user-facing handling includes:

- clear registration progress
- receiver-not-registered errors before send
- stale Merkle proof retry messaging
- nullifier-already-burnt skip behavior
- encrypted balance polling timeouts
- withdrawal queued state for Arcium MPC settlement

