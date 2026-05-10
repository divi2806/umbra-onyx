import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * This endpoint is no longer used for the primary scan flow.
 * Received UTXO scanning now happens client-side via the Umbra SDK
 * in `lib/umbra/use-scanned-history.ts`.
 *
 * Kept as a stub to avoid 404s from any cached requests.
 */
export async function POST() {
  return NextResponse.json(
    { error: "Client-side UTXO scanning is now used. This endpoint is deprecated." },
    { status: 410 },
  );
}
