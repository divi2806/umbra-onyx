# Onyx

**Confidential payment infrastructure for onchain teams.**

Onyx lets Solana teams send payroll, invoices, vendor payments, and treasury transfers through Umbra shielded UTXOs so payment amounts and recipients are not exposed on the public ledger.

- **Frontend:** https://onyx-red.vercel.app/
- **Integration details:** [integration.md](integration.md)
- **Architecture:** [architecture.md](architecture.md)

---

## The Problem

Every normal SOL, USDC, or USDT transfer on Solana is public forever. Payroll runs, contractor rates, vendor bills, treasury movements, and recurring team payments can be indexed by competitors, recruiters, bots, and anyone watching the chain.

Onyx solves this by giving teams a non-custodial payment workflow where funds move through Umbra's privacy layer while the team keeps local, shareable audit records.

## Target Users And Use Cases

**Target users**

- DAOs and protocols paying contributors.
- Founders and finance teams paying contractors or vendors.
- Treasury operators making private rebalances, grants, or buybacks.
- Auditors or internal finance reviewers who need bounded access to payment records.

**Use cases**

- Single private send from `/pay`.
- Batch payroll from `/payroll`.
- Saved recipient roster and payment schedules from `/team`.
- Invoice requests from `/invoice` and payer flow from `/claim`.
- Received-payment scanning, claim, and withdrawal from `/history`.
- Date-scoped audit access from `/compliance` and auditor review from `/audit`.

---

## How Onyx Uses The Umbra SDK

Onyx uses `@umbra-privacy/sdk@5.0.0-rc.6` as the privacy layer, including the bundled browser ZK provers. The app does not deploy a custom payment program; it composes Umbra's deployed Solana programs, indexer, relayer, registration, scanner, prover, Stealth Pool Note, burn, and withdrawal APIs.

| Umbra SDK capability | Onyx usage |
|---|---|
| `getUmbraClient` | Creates a wallet-bound Umbra client with RPC, WebSocket, indexer, transaction forwarder, and computation monitor configuration. |
| `getUserRegistrationFunction` | Performs one-time confidential and anonymous registration so wallets can receive shielded UTXOs. |
| `getATAIntoReceiverBurnableStealthPoolNoteCreatorFunction` | Sends public wallet funds into a receiver-burnable Stealth Pool Note. |
| `getBurnableStealthPoolNoteScannerFunction` | Scans Umbra trees for notes the connected wallet can burn. |
| `getReceiverBurnableStealthPoolNoteIntoETABurnerFunction` | Burns receiver notes into an Umbra Encrypted Token Account through the relayer. |
| `getETAIntoATAWithdrawerFunction` | Withdraws encrypted balance back to the receiver's public wallet. |
| Umbra viewing key derivation | Powers Onyx audit access keys, which are date-scoped read-only tokens for auditors. |

Important Umbra implementation files:

- `lib/umbra/client.tsx` - Umbra client provider, registration helper, random generation index helper, custom transaction forwarder.
- `lib/umbra/umbra-send-core.ts` - single send orchestration.
- `lib/umbra/use-claim-utxo.ts` - scan, claim into encrypted balance, and withdraw.
- `lib/umbra/use-scanned-history.ts` - received UTXO scan/cache hook.
- `lib/umbra/viewing-keys.ts` - audit access key storage and token encode/decode.
- `lib/umbra/tokens.ts` - Umbra-supported token registry by network.

---

## Network

| Network | Solana cluster | Umbra program ID | Indexer | Relayer |
|---|---|---|---|---|
| Devnet | `devnet` | `DSuKkyqGVGgo4QtPABfxKJKygUDACbUhirnuv63mEpAJ` | `https://utxo-indexer.api-devnet.umbraprivacy.com` | `https://relayer.api-devnet.umbraprivacy.com` |

Onyx is currently devnet-only. It ignores `NEXT_PUBLIC_SOLANA_CLUSTER` and always boots on Solana devnet. Devnet currently supports SOL/wSOL only in this app.

---

## Audit Access Keys

The old "compliance key" wording is now represented in the app as an **Audit access key**. Technically, it is an Umbra viewing-key-based token plus a scoped snapshot of locally synced received UTXOs.

What the wallet holder does:

1. Open `/history` and sync received payments so Onyx has the latest received UTXO rows.
2. Open `/compliance`, choose an auditor label and date range, then generate an audit access key.
3. Copy the generated token and send it to the auditor through their normal secure channel.

What the auditor does with the key:

1. Open `/audit`.
2. Paste the audit access token.
3. Run the audit scan.
4. Review the date-bounded payment rows and download the CSV report.

What the key can and cannot do:

- It can reveal only the included date-scoped audit snapshot.
- It can help an auditor verify received-payment records for the selected wallet and period.
- It cannot spend funds, claim UTXOs, withdraw balances, or control the wallet.
- Archiving a key removes it from the issuer's current browser storage, but already-shared snapshot tokens cannot be recalled.

---

## Build, Test, And Run

### Prerequisites

- Node.js 18+
- pnpm
- A Solana wallet such as Phantom, Solflare, or Backpack

### Install

```bash
git clone <repo-url>
cd nori-main
pnpm install
```

### Environment

Onyx runs on devnet. Create `.env.local` only when overriding the default devnet RPC:

```env
# Optional devnet RPC override.
NEXT_PUBLIC_SOLANA_RPC_URL=https://api.devnet.solana.com
NEXT_PUBLIC_SOLANA_WS_URL=wss://api.devnet.solana.com
```

### Run locally

```bash
pnpm dev
```

Open `http://localhost:3000`.

### Build and verification commands

```bash
pnpm build
pnpm lint
pnpm test:faucet
```

`pnpm test:faucet` is a devnet helper script for funding a test wallet. There is no broad automated test suite yet; most Umbra flows are currently verified manually with wallet interaction on devnet.

### Using the application

1. Open Onyx on devnet.
2. First-time visitors see a walkthrough modal that explains private sends, Umbra registration, claiming, and audit access.
3. Connect a Solana wallet.
4. Wait for Umbra registration to finish if this is the wallet's first use.
5. Use `/pay` for a private transfer or `/payroll` for CSV batch payments.
6. Use `/invoice` to create a payment request link and `/claim` to pay an invoice.
7. Use `/history` to scan received UTXOs, claim, and withdraw.
8. Use `/compliance` to issue audit access keys and `/audit` to inspect an audit token.

---

## Deployment And Program IDs

Onyx currently uses Umbra's deployed Solana programs and does not ship an Onyx-owned Solana program.

| Item | Value |
|---|---|
| Frontend | https://umbra-onyx.vercel.app/ |
| Umbra devnet program | `DSuKkyqGVGgo4QtPABfxKJKygUDACbUhirnuv63mEpAJ` |

---

## Stack

- Next.js 16 App Router and React 19
- TypeScript 5
- Tailwind CSS 4 and local UI components
- `@solana/web3.js`, `@solana/kit`, and wallet adapter packages
- `@umbra-privacy/sdk`
- Framer Motion via `motion/react`
- Hugeicons

---

## License

[LICENSE](LICENSE)
