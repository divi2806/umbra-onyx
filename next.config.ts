import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Next / Turbopack auto-injects `Buffer` via `next/dist/compiled/buffer`
  // (feross/buffer v5), which lacks `readBigInt64LE` and friends needed by
  // the Umbra SDK. Force `buffer` to resolve to npm `buffer@6.x` which
  // implements the BigInt Buffer methods.
  turbopack: {
    root: process.cwd(),
    resolveAlias: {
      buffer: {
        browser: "buffer",
        default: "node:buffer",
      },
    },
  },
};

export default nextConfig;
