type SignMessage = (message: Uint8Array) => Promise<Uint8Array>;

// Caches signatures by message bytes so the same deterministic message
// (Umbra master-seed derivation via UMBRA_MESSAGE_TO_SIGN) doesn't re-prompt
// the wallet on every operation. Ed25519 is deterministic for a given key +
// message, so the cached signature is always valid for the same input.
export function createMemoizedSignMessage(signMessage: SignMessage): SignMessage {
  const cache = new Map<string, Uint8Array>();
  return async (message: Uint8Array): Promise<Uint8Array> => {
    const key = bytesToHex(message);
    const cached = cache.get(key);
    if (cached) return cached;
    const sig = await signMessage(message);
    cache.set(key, sig);
    return sig;
  };
}

function bytesToHex(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 1) {
    s += bytes[i].toString(16).padStart(2, "0");
  }
  return s;
}
