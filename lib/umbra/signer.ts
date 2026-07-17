"use client";

import type { GetUmbraClientArgs } from "@umbra-privacy/sdk/client";
import {
  type Address,
  type Transaction,
  type TransactionWithBlockhashLifetime,
  getTransactionEncoder,
} from "@solana/kit";
import { fromLegacyPublicKey } from "@solana/compat";
import { VersionedTransaction } from "@solana/web3.js";
import type { WalletContextState } from "@solana/wallet-adapter-react";

// IUmbraSigner is not re-exported from the main index but is the type of
// GetUmbraClientArgs['signer'], so we derive it here.
export type IUmbraSigner = GetUmbraClientArgs["signer"];

type SignableTransaction = Transaction & TransactionWithBlockhashLifetime;

/**
 * Extracts the non-zero signatures from a signed VersionedTransaction and
 * returns them as a plain Record<string, Uint8Array> keyed by base58 address.
 *
 * We do this instead of going through decoder.decode(signed.serialize()) because
 * the Kit decoder reconstructs a brand-new transaction object. Even though we
 * only pull .signatures off it, the round-trip can produce signature values in
 * read-only / branded forms that the SDK's transaction forwarder rejects.
 * Reading straight from VersionedTransaction.signatures is always safe.
 */
function extractSignatures(signed: VersionedTransaction): Record<string, Uint8Array> {
  const { numRequiredSignatures } = signed.message.header;
  const result: Record<string, Uint8Array> = {};
  for (let i = 0; i < numRequiredSignatures; i++) {
    const pubkey = signed.message.staticAccountKeys[i];
    const sig = signed.signatures[i];
    // Skip placeholder zero-filled signatures (unsigned slots).
    if (pubkey && sig && sig.some((b) => b !== 0)) {
      result[pubkey.toBase58()] = sig;
    }
  }
  return result;
}

/**
 * Adapts the Solana wallet adapter context into an IUmbraSigner the Umbra SDK
 * can use to sign @solana/kit-style transactions and messages.
 *
 * Returns null when the wallet is not connected or lacks signing capabilities.
 */
export function createUmbraSigner(wallet: WalletContextState): IUmbraSigner | null {
  if (!wallet.publicKey || !wallet.signTransaction || !wallet.signMessage) return null;

  const address = fromLegacyPublicKey(wallet.publicKey) as Address;
  const encoder = getTransactionEncoder();

  // Sign a @solana/kit transaction via the legacy wallet adapter.
  //
  // CRITICAL: We spread `...tx` first so that messageBytes and every other
  // field the Umbra SDK needs for forwarding is preserved on the returned
  // object. We then ONLY update the `signatures` map — mirroring what the
  // SDK's own convertWalletStandardAccountToIUmbraSigner does internally:
  //
  //   const decoded = decoder.decode(output.signedTransaction);
  //   return { ...transaction, signatures: { ...transaction.signatures, ...decoded.signatures } };
  //
  // The difference is that we extract signatures directly from the
  // VersionedTransaction rather than through a decoder round-trip, which
  // avoids any risk of the round-trip stripping or re-typing signature bytes.
  const signKitTransaction = async (tx: SignableTransaction) => {
    console.log("[umbra-signer] signTransaction called for address:", address);
    const bytes = encoder.encode(tx);
    const legacyTx = VersionedTransaction.deserialize(new Uint8Array(bytes));
    let signed;
    try {
      signed = await wallet.signTransaction!(legacyTx);
    } catch (err) {
      console.error("[umbra-signer] wallet.signTransaction FAILED:", err);
      throw err;
    }
    const newSigs = extractSignatures(signed);
    console.log("[umbra-signer] ✔ signTransaction done, signers:", Object.keys(newSigs));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return { ...tx, signatures: { ...(tx.signatures ?? {}), ...newSigs } } as any;
  };

  return {
    address,
    signTransaction: signKitTransaction,
    signTransactions: async (txs) => {
      console.log("[umbra-signer] signTransactions called, count:", txs.length);
      if (wallet.signAllTransactions) {
        const legacyTxs = txs.map((tx) =>
          VersionedTransaction.deserialize(new Uint8Array(encoder.encode(tx))),
        );
        let signedAll;
        try {
          signedAll = await wallet.signAllTransactions!(legacyTxs);
        } catch (err) {
          console.error("[umbra-signer] wallet.signAllTransactions FAILED:", err);
          throw err;
        }
        console.log("[umbra-signer] ✔ signTransactions done, count:", signedAll.length);
        return signedAll.map((signed, i) => {
          const newSigs = extractSignatures(signed);
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          return { ...txs[i], signatures: { ...(txs[i].signatures ?? {}), ...newSigs } } as any;
        });
      }
      return Promise.all(txs.map(signKitTransaction));
    },
    signMessage: async (message: Uint8Array) => {
      console.log("[umbra-signer] signMessage called, msgLen:", message.length);
      let signature;
      try {
        signature = await wallet.signMessage!(message);
      } catch (err) {
        console.error("[umbra-signer] wallet.signMessage FAILED:", err);
        throw err;
      }
      console.log("[umbra-signer] ✔ signMessage done, sigLen:", signature.length);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return { message, signature, signer: address } as any;
    },
  };
}
