# Integration test scripts

Node-side utilities for testing against the Umbra privacy protocol on Solana
devnet. These scripts use a local Solana keypair instead of a wallet adapter.

These submit **real transactions** on the cluster you target. Use a dedicated
test keypair and small amounts.

## Setup

1. Have a Solana keypair JSON file (Solana CLI format — a 64-byte JSON array).
   Quickest way:

   ```sh
   solana-keygen new --outfile ~/.config/solana/test.json
   ```

2. Fund the keypair with devnet SOL for transaction fees:

   ```sh
   solana airdrop 2 --keypair ~/.config/solana/test.json --url https://api.devnet.solana.com
   ```

3. Mint devnet mock USDC if you want to test SPL-token sends:

   ```sh
   KEYPAIR=~/.config/solana/test.json pnpm test:faucet
   ```

## Scripts

All read config from env vars. Every script exits with a non-zero status on
failure so they're CI-friendly.

### `pnpm test:faucet`

Requests devnet mock USDC from the Umbra/Solana faucet for a given wallet.

| env | required | example |
|---|---|---|
| `WALLET` | one of `WALLET` or `KEYPAIR` | base58 wallet address |
| `KEYPAIR` | one of `WALLET` or `KEYPAIR` | path to keypair JSON |
| `AMOUNT` | no, default `100` | mock USDC amount to request |

```sh
WALLET=8gm5X1Nq8f28qu5XPTXk236FVmEufFprFmceRssYzMuk pnpm test:faucet
```

Devnet only. This does not airdrop SOL; use `solana airdrop` for fee SOL.

## Testing the Umbra send flow

The frontend integration (register → send → scan → claim) is tested via the
app UI on devnet:

1. Connect a wallet — the app auto-registers with Umbra on first connect.
2. Use `/pay` to send a shielded payment to a recipient address.
3. Switch to the recipient wallet and use `/history` to scan for received UTXOs.
4. Claim from the history page.

Both sender and recipient must be registered with Umbra before any shielded
payment can be received. Registration is automatic when a wallet connects to
the app.
