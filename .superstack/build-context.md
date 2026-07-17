# Onyx build context

Onyx is a devnet-only Next.js frontend for confidential Solana payments using
the Umbra Privacy SDK. It supports wallet registration, private sends, batch
payroll, note scanning, burning/claiming, and withdrawal.

## Debug

- `issues_resolved`:
  - Error: Umbra registration transaction signatures remained absent from all
    clusters and the UI polled forever.
  - Cause: `@umbra-privacy/sdk@3.0.0` generated a legacy account-initialisation
    instruction rejected by the current devnet program with Anchor error 101,
    `InstructionFallbackNotFound`.
  - Fix: migrated Onyx to `@umbra-privacy/sdk@5.0.0-rc.6`, aligned Solana Kit
    packages, moved all operation/prover imports to v5 subpaths, updated send,
    scan, burn, and withdrawal APIs, and added signed-wire simulation before
    broadcasting. The same devnet registration instruction now simulates with
    `err: null` and logs `RegisterUserForConfidentialUsage` successfully.
- `last_debug_session`: 2026-07-17T20:16:32+05:30
