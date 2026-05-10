# Onyx Architecture

Onyx is a client-side Next.js application that composes Solana wallets and the Umbra Privacy SDK. It does not run a custodial backend and does not deploy a custom Solana program.

## High-Level Architecture

```text
Browser
  |
  |-- Next.js App Router UI
  |-- Solana wallet adapter
  |-- Umbra SDK client
  |-- Web ZK provers
  |-- Local storage records
  |
Solana RPC
  |
Umbra programs on Solana
  |
Umbra indexer and relayer
```

## Application Layers

### App routes

```text
app/
  page.tsx              Marketing/home page
  (app)/
    pay/                Single private send
    payroll/            CSV batch payroll
    team/               Saved recipients and schedules
    history/            Outbound ledger, received scan, claim, withdraw
    compliance/         Audit access key issue/archive/export UI
    invoice/            Invoice request creation
  claim/                Public invoice payer route
  audit/                Public audit token review route
  api/scan-received/    Deprecated scan endpoint; scan now happens client-side
```

### Components

```text
components/
  app-shell/            Sidebar, top bar, navigation
  solana/               Wallet connect, balance, network selector
  onboarding/           First-visit walkthrough modal
  team/                 Team payment UI
  sections/             Marketing sections
  ui/                   Shared primitives
```

### Libraries

```text
lib/
  solana/
    config.ts           Cluster, RPC, WebSocket, one-click network override
    providers.tsx       Wallet and connection providers
    explorer.ts         Explorer URL helpers
    rpc.ts              Solana Kit RPC clients

  umbra/
    config.ts           Umbra network, indexer, relayer mapping
    client.tsx          Umbra client provider and registration
    signer.ts           Wallet adapter to Umbra signer bridge
    umbra-send-core.ts  Private send orchestration
    use-claim-utxo.ts   Scan, claim, encrypted balance, withdraw flow
    use-scanned-history.ts
    scanned-history.ts
    payment-history.ts
    invoice.ts
    viewing-keys.ts
    derive-mvk.ts
    tokens.ts

  team/
    storage.ts
    schedule.ts
    validation helpers

  payroll/
    parse-csv.ts
    validate.ts
```

## State Model

Onyx keeps state local to the user's browser.

| State | Storage |
|---|---|
| Selected network | `localStorage` key `onyx:solana-cluster:v1` |
| First-visit walkthrough | `localStorage` key `onyx:first-visit-walkthrough:v1` |
| Outbound payments | local storage keyed by sender wallet and cluster |
| Received UTXO scan cache | local storage keyed by receiver wallet and cluster |
| Invoice requests | local storage keyed by receiver wallet and cluster |
| Audit access keys | local storage keyed by issuer wallet and cluster |
| Team roster and schedules | local storage keyed by cluster |

Because records are cluster-scoped, switching from Mainnet to Devnet changes the active local ledger, token set, and Umbra endpoints.

## Network Selection

`components/solana/network-switcher.tsx` renders the one-click selector. It supports:

- Mainnet
- Devnet

When the user selects a network:

1. Onyx writes the selected cluster to `localStorage`.
2. The page reloads.
3. `lib/solana/config.ts` reads the override.
4. `SolanaProvider` uses the selected RPC endpoint.
5. `UmbraClientProvider` builds a fresh Umbra client for that network.
6. Storage helpers read/write under cluster-specific keys.

This reload-based switch keeps the existing SDK clients and wallet providers from mixing network state.

## Privacy And Trust Boundaries

### What remains local

- Wallet signatures
- Umbra master seed derivation
- Audit access key generation
- Local payment history
- Received UTXO scan cache
- Invoice records
- Team records

### What goes on-chain

- Umbra registration transactions
- UTXO creation transactions
- Claim transactions submitted through the relayer
- Encrypted-balance withdraw transactions

### What external Umbra services provide

- Indexer data for UTXO scanning and Merkle proofs
- Relayer submission for privacy-preserving claim operations
- Arcium MPC callback settlement used by Umbra encrypted-balance operations

## Main Data Flows

### Private send

```text
Pay UI
  -> validate recipient and amount
  -> ensure sender Umbra registration
  -> assert receiver Umbra registration
  -> generate ZK proof in browser
  -> create receiver-claimable UTXO
  -> store local outbound history
```

### Receive and claim

```text
History UI
  -> scan Umbra trees
  -> cache received UTXOs
  -> claim selected UTXOs into encrypted balance
  -> withdraw encrypted balance to public wallet
  -> mark local rows as queued/transferred
```

### Audit access

```text
History sync
  -> received UTXO snapshot
  -> /compliance date range
  -> audit access token
  -> /audit token review
  -> CSV export
```

## Deployed Programs

Onyx currently relies on Umbra's deployed program IDs:

| Network | Program ID |
|---|---|
| Mainnet | `UMBRAD2ishebJTcgCLkTkNUx1v3GyoAgpTRPeWoLykh` |
| Devnet | `DSuKkyqGVGgo4QtPABfxKJKygUDACbUhirnuv63mEpAJ` |

No Onyx-owned Solana program ID is currently deployed.

## Operational Notes

- Devnet supports only SOL/wSOL in the current token registry.
- Mainnet token support follows the Umbra supported-token list in `lib/umbra/tokens.ts`.
- Fresh random Umbra generation indices are required for UTXO creation and claim flows.
- Arcium MPC settlement can lag, so UI states must show queued/pending progress.
- Lint and build are available, but this repository preference is not to run them unless explicitly requested.
