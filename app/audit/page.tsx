"use client";

import {
  CheckmarkCircle01Icon,
  Download01Icon,
  FileSecurityIcon,
  Search01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import Link from "next/link";
import * as React from "react";

import { OnyxMark } from "@/components/logos";
import { NetworkSwitcher } from "@/components/solana/network-switcher";
import { FancyButton } from "@/components/ui/fancy-button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { decodeViewingKeyToken } from "@/lib/umbra/viewing-keys";
import { loadScan, type ReceivedUtxo } from "@/lib/umbra/scanned-history";
import { solanaConfig } from "@/lib/solana/config";
import { cn } from "@/lib/utils";

type ScanState = "idle" | "scanning" | "done" | "error";

type ReportSummary = {
  totalReceived: bigint;
  utxoCount: number;
  symbol: string;
  decimals: number;
};

function formatUtxoCsv(utxos: ReceivedUtxo[], dateFrom: string, dateTo: string): string {
  const header = ["Date", "Amount", "Symbol", "Mint", "Tree", "InsertionIndex", "Destination"].join(",");
  const rows = utxos.map((u) => {
    const date = new Date(u.timestamp).toISOString();
    return [date, u.amount, u.symbol, u.mint, u.treeIndex, u.insertionIndex, u.destinationAddress].join(",");
  });
  if (rows.length === 0) {
    rows.push(`# No UTXOs found between ${dateFrom} and ${dateTo}`);
  }
  return [header, ...rows].join("\n");
}

function fmtBaseUnits(amount: string, decimals: number, symbol: string): string {
  try {
    const n = Number(BigInt(amount)) / 10 ** decimals;
    return `${n.toLocaleString(undefined, { maximumFractionDigits: decimals })} ${symbol}`;
  } catch {
    return `${amount} base units`;
  }
}

function isTokenUtxoSnapshot(utxos: unknown): utxos is ReceivedUtxo[] {
  if (!Array.isArray(utxos)) return false;
  return utxos.every((u) => {
    if (!u || typeof u !== "object") return false;
    const r = u as Record<string, unknown>;
    return (
      typeof r.treeIndex === "number" &&
      typeof r.insertionIndex === "number" &&
      typeof r.amount === "string" &&
      typeof r.mint === "string" &&
      typeof r.decimals === "number" &&
      typeof r.symbol === "string" &&
      typeof r.destinationAddress === "string" &&
      typeof r.timestamp === "number"
    );
  });
}

export default function AuditPage() {
  const [token, setToken] = React.useState("");
  const [state, setState] = React.useState<ScanState>("idle");
  const [error, setError] = React.useState<string | null>(null);
  const [utxos, setUtxos] = React.useState<ReceivedUtxo[]>([]);
  const [summary, setSummary] = React.useState<ReportSummary | null>(null);
  const [csvData, setCsvData] = React.useState<string | null>(null);
  const [dateRange, setDateRange] = React.useState<{ from: string; to: string } | null>(null);

  const tokenDecoded = React.useMemo(() => decodeViewingKeyToken(token.trim()), [token]);

  function handleScan() {
    const parsed = decodeViewingKeyToken(token.trim());
    if (!parsed) {
      setError("Invalid token. Paste the base64 token issued from the Audit Access page.");
      return;
    }

    setState("scanning");
    setError(null);
    setUtxos([]);
    setSummary(null);
    setCsvData(null);
    setDateRange({ from: parsed.from, to: parsed.to });

    try {
      const afterTimestamp = new Date(parsed.from).getTime();
      const beforeTimestamp = new Date(parsed.to).getTime() + 86_400_000 - 1;

      const tokenSnapshot = isTokenUtxoSnapshot(parsed.utxos)
        ? parsed.utxos
        : null;
      const stored = tokenSnapshot
        ? null
        : loadScan(parsed.wallet, parsed.cluster ?? solanaConfig.cluster);
      const sourceUtxos = tokenSnapshot ?? stored?.report.utxos ?? [];
      const filtered = sourceUtxos.filter(
        (u) => u.timestamp >= afterTimestamp && u.timestamp <= beforeTimestamp,
      );

      // Build summary — group by most common symbol.
      let totalReceived = 0n;
      const symbolCounts: Record<string, number> = {};
      const decimalsBySymbol: Record<string, number> = {};
      for (const u of filtered) {
        try { totalReceived += BigInt(u.amount); } catch { /* ignore */ }
        symbolCounts[u.symbol] = (symbolCounts[u.symbol] ?? 0) + 1;
        decimalsBySymbol[u.symbol] = u.decimals;
      }
      const topSymbol = Object.entries(symbolCounts).sort((a, b) => b[1] - a[1])[0]?.[0] ?? "SOL";

      setSummary({
        totalReceived,
        utxoCount: filtered.length,
        symbol: topSymbol,
        decimals: decimalsBySymbol[topSymbol] ?? 9,
      });
      setUtxos(filtered);
      setCsvData(formatUtxoCsv(filtered, parsed.from, parsed.to));
      setState("done");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Scan failed.");
      setState("error");
    }
  }

  function handleDownload() {
    if (!csvData || !dateRange) return;
    const blob = new Blob([csvData], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `onyx-audit-${dateRange.from}-to-${dateRange.to}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  const isLoading = state === "scanning";

  return (
    <div className="min-h-screen bg-background text-foreground">
      {/* Minimal nav */}
      <header className="flex h-14 items-center gap-3 border-b border-border px-6">
        <Link href="/" className="flex items-center gap-2.5">
          <OnyxMark className="size-6" />
          <span className="text-[15px] font-semibold tracking-tight">Onyx</span>
        </Link>
        <div className="h-5 w-px bg-border" />
        <span className="text-[13px] text-muted-foreground">Audit Portal</span>
        <div className="ml-auto">
          <NetworkSwitcher />
        </div>
      </header>

      <main className="mx-auto max-w-3xl px-4 py-12 sm:px-8">
        {/* Page header */}
        <div className="mb-10 flex items-start gap-4">
          <div className="grid size-12 place-items-center rounded-2xl border border-primary/20 bg-primary/10 text-primary">
            <HugeiconsIcon icon={FileSecurityIcon} size={22} strokeWidth={1.5} />
          </div>
          <div>
            <h1 className="text-[22px] font-semibold tracking-tight text-foreground">
              Audit Access Review
            </h1>
            <p className="mt-1 text-[13.5px] leading-5 text-muted-foreground">
              Paste the token issued by your counterparty. Onyx loads the locally-cached
              UTXO snapshot and filters it to the authorised date range — no wallet required.
            </p>
          </div>
        </div>

        {/* Input card */}
        <div className="flex flex-col gap-6 rounded-2xl border border-border bg-card/60 p-6 sm:p-8">
          <div className="flex flex-col gap-2">
            <Label htmlFor="vkToken">Audit access token</Label>
            <Input
              id="vkToken"
              placeholder="Paste the base64 token here…"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              className="font-mono text-[12.5px]"
              disabled={isLoading}
            />
            {tokenDecoded && (
              <p className="text-[11.5px] text-primary">
                Range: {tokenDecoded.from} → {tokenDecoded.to} · wallet{" "}
                {tokenDecoded.wallet.slice(0, 6)}…{tokenDecoded.wallet.slice(-4)}
                {tokenDecoded.cluster ? ` · ${tokenDecoded.cluster}` : ""}
              </p>
            )}
          </div>

          {error && (
            <p className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-[12.5px] text-destructive">
              {error}
            </p>
          )}

          <FancyButton
            variant="primary"
            size="lg"
            className="self-start"
            onClick={handleScan}
            disabled={!token.trim() || isLoading}
          >
            {isLoading ? (
              <>
                <HugeiconsIcon
                  icon={Search01Icon}
                  size={14}
                  strokeWidth={2.2}
                />
                Loading…
              </>
            ) : (
              <>
                Run audit scan
                <HugeiconsIcon icon={Search01Icon} size={14} strokeWidth={2.2} />
              </>
            )}
          </FancyButton>

          <p className="text-[11.5px] text-muted-foreground">
            Note: Current tokens include a scoped Umbra scan snapshot. Older tokens without a snapshot
            can only be opened in the same browser that has the wallet holder&apos;s scan cache.
          </p>
        </div>

        {/* Results */}
        {state === "done" && summary && dateRange && (
          <div className="mt-8 flex flex-col gap-6">

            {/* Summary stats */}
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              {[
                { label: "UTXOs", value: String(summary.utxoCount) },
                { label: "Total received", value: fmtBaseUnits(summary.totalReceived.toString(), summary.decimals, summary.symbol) },
                { label: "Date range", value: `${dateRange.from} → ${dateRange.to}` },
              ].map((stat) => (
                <div
                  key={stat.label}
                  className="rounded-xl border border-border bg-card/60 p-4"
                >
                  <p className="text-[11px] uppercase tracking-[0.1em] text-muted-foreground">
                    {stat.label}
                  </p>
                  <p className="mt-1 font-mono text-[14px] font-medium text-foreground">
                    {stat.value}
                  </p>
                </div>
              ))}
            </div>

            {/* Download bar */}
            <div className="flex items-center justify-between rounded-xl border border-primary/20 bg-primary/5 px-4 py-3">
              <div className="flex items-center gap-2 text-[13px] text-foreground">
                <HugeiconsIcon
                  icon={CheckmarkCircle01Icon}
                  size={15}
                  strokeWidth={2}
                  className="text-primary"
                />
                Scan complete · {dateRange.from} → {dateRange.to}
              </div>
              <button
                type="button"
                onClick={handleDownload}
                className="flex items-center gap-1.5 rounded-lg border border-primary/30 bg-primary/10 px-3 py-1.5 text-[12.5px] font-medium text-primary transition-colors hover:bg-primary/20"
              >
                <HugeiconsIcon icon={Download01Icon} size={13} strokeWidth={2} />
                Download CSV
              </button>
            </div>

            {/* Transaction table */}
            {utxos.length > 0 ? (
              <div className="overflow-x-auto rounded-2xl border border-border">
                <table className="w-full text-left text-[12.5px]">
                  <thead>
                    <tr className="border-b border-border bg-card/60">
                      {["Date", "Amount", "Symbol", "Mint", "Destination"].map((h) => (
                        <th
                          key={h}
                          className="px-4 py-2.5 font-medium text-muted-foreground"
                        >
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {utxos.map((u, i) => (
                      <tr
                        key={`${u.treeIndex}-${u.insertionIndex}`}
                        className={cn(
                          "border-b border-border/60",
                          i % 2 === 0 ? "bg-background/40" : "bg-card/40",
                        )}
                      >
                        <td className="px-4 py-2.5 text-muted-foreground">
                          {new Date(u.timestamp).toLocaleDateString()}
                        </td>
                        <td className="px-4 py-2.5 font-mono text-foreground">
                          {fmtBaseUnits(u.amount, u.decimals, u.symbol)}
                        </td>
                        <td className="px-4 py-2.5">
                          <span className="rounded px-1.5 py-0.5 font-mono text-[11px] bg-primary/10 text-primary">
                            {u.symbol}
                          </span>
                        </td>
                        <td className="px-4 py-2.5 font-mono text-muted-foreground">
                          {u.mint.slice(0, 4)}…{u.mint.slice(-4)}
                        </td>
                        <td className="px-4 py-2.5 font-mono text-muted-foreground">
                          {u.destinationAddress.slice(0, 4)}…{u.destinationAddress.slice(-4)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="rounded-xl border border-border bg-card/60 px-4 py-6 text-center text-[13px] text-muted-foreground">
                No UTXOs found in this date range. Ask the wallet holder to sync received payments on History and issue a fresh token if records are missing.
              </p>
            )}
          </div>
        )}
      </main>
    </div>
  );
}
