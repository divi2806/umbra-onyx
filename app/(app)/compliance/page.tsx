"use client";

import {
  ArrowRight01Icon,
  CheckmarkCircle01Icon,
  Copy01Icon,
  Delete02Icon,
  Download01Icon,
  EyeIcon,
  FileSecurityIcon,
  KeyIcon,
  Loading03Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useWallet } from "@solana/wallet-adapter-react";
import { motion } from "motion/react";
import * as React from "react";

import { FancyButton } from "@/components/ui/fancy-button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { deriveMvk } from "@/lib/umbra/derive-mvk";
import { useUmbraClient, useUmbraClientState } from "@/lib/umbra/client";
import { useViewingKeys } from "@/lib/umbra/use-viewing-keys";
import {
  addViewingKey,
  encodeViewingKeyToken,
  revokeViewingKey,
  type ViewingKey,
} from "@/lib/umbra/viewing-keys";
import { loadScan } from "@/lib/umbra/scanned-history";
import type { ReceivedUtxo } from "@/lib/umbra/scanned-history";
import { solanaConfig } from "@/lib/solana/config";
import { cn } from "@/lib/utils";

type GenerateState = "idle" | "deriving" | "done" | "error";

function formatUtxoCsv(utxos: ReceivedUtxo[]): string {
  const header = ["Date", "Amount", "Decimals", "Symbol", "Mint", "Tree", "InsertionIndex", "Destination"].join(",");
  const rows = utxos.map((u) => {
    const date = new Date(u.timestamp).toISOString();
    return [date, u.amount, u.decimals, u.symbol, u.mint, u.treeIndex, u.insertionIndex, u.destinationAddress].join(",");
  });
  return [header, ...rows].join("\n");
}

function scopedReceivedUtxos(
  wallet: string,
  keyDateFrom: string,
  keyDateTo: string,
): ReceivedUtxo[] {
  const afterTimestamp = new Date(keyDateFrom).getTime();
  const beforeTimestamp = new Date(keyDateTo).getTime() + 86_400_000 - 1;

  const stored = loadScan(wallet, solanaConfig.cluster);
  return (stored?.report.utxos ?? []).filter(
    (u) => u.timestamp >= afterTimestamp && u.timestamp <= beforeTimestamp,
  );
}

export default function CompliancePage() {
  const { publicKey } = useWallet();
  const client = useUmbraClient();
  const umbraStatus = useUmbraClientState().status;
  const isRegistering = umbraStatus === "connecting" || umbraStatus === "registering";
  const viewingKeys = useViewingKeys();

  const [auditor, setAuditor] = React.useState("");
  const [dateFrom, setDateFrom] = React.useState("");
  const [dateTo, setDateTo] = React.useState("");
  const [state, setState] = React.useState<GenerateState>("idle");
  const [lastToken, setLastToken] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [copied, setCopied] = React.useState<string | null>(null);
  const [exporting, setExporting] = React.useState<string | null>(null);

  // Cached MVK for this wallet session (same wallet = same MVK every time).
  const mvkCacheRef = React.useRef<{
    mvkHex: string;
    key: string;
  } | null>(null);

  async function getOrDeriveMvk() {
    if (!client) throw new Error("Umbra client not ready — connect your wallet.");
    const walletKey = publicKey!.toBase58();
    if (mvkCacheRef.current?.key === walletKey) {
      return mvkCacheRef.current.mvkHex;
    }
    const { mvkHex } = await deriveMvk(client);
    mvkCacheRef.current = { mvkHex, key: walletKey };
    return mvkHex;
  }

  async function handleGenerate() {
    if (!publicKey) return;
    if (!auditor.trim() || !dateFrom || !dateTo) return;

    setState("deriving");
    setError(null);
    setLastToken(null);

    try {
      const mvkHex = await getOrDeriveMvk();
      const scopedUtxos = scopedReceivedUtxos(
        publicKey.toBase58(),
        dateFrom,
        dateTo,
      );

      const vk = addViewingKey(solanaConfig.cluster, publicKey.toBase58(), {
        auditor: auditor.trim(),
        dateFrom,
        dateTo,
        nkHex: mvkHex,
        utxos: scopedUtxos,
      });

      setLastToken(encodeViewingKeyToken(vk));
      setState("done");
      setAuditor("");
      setDateFrom("");
      setDateTo("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Key generation failed.");
      setState("error");
    }
  }

  function handleRevoke(id: string) {
    if (!publicKey) return;
    revokeViewingKey(solanaConfig.cluster, publicKey.toBase58(), id);
  }

  async function handleCopy(text: string, id: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(id);
      setTimeout(() => setCopied(null), 2000);
    } catch { /* clipboard blocked */ }
  }

  async function handleExportCsv(
    key: ViewingKey,
  ) {
    if (!publicKey || exporting) return;
    setExporting(key.id);
    try {
      const utxos = key.utxos ?? scopedReceivedUtxos(
        publicKey.toBase58(),
        key.dateFrom,
        key.dateTo,
      );

      const csv = formatUtxoCsv(utxos);
      const blob = new Blob([csv], { type: "text/csv" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `onyx-audit-${key.dateFrom}-to-${key.dateTo}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Export failed.";
      setError(msg);
    } finally {
      setExporting(null);
    }
  }

  const canGenerate = !!publicKey && !!client && auditor.trim().length > 0 && !!dateFrom && !!dateTo;
  const isLoading = state === "deriving";

  const stateLabel: Record<GenerateState, string> = {
    idle: "Generate audit key",
    deriving: "Deriving access key…",
    done: "Generate audit key",
    error: "Try again",
  };

  const activeKeys = viewingKeys.filter((k) => !k.revoked);
  const revokedKeys = viewingKeys.filter((k) => k.revoked);

  return (
    <div className="mx-auto w-full max-w-screen-xl px-5">
      <div className="py-8">
        <span className="inline-flex items-center gap-2 rounded-full border border-primary/22 bg-primary/8 px-3 py-1 text-[10.5px] font-semibold uppercase tracking-[0.16em] text-primary/75">
          <span className="size-1.5 rounded-full bg-primary/70" />
          Regulatory Audit
        </span>
        <div className="mt-3 flex items-center justify-between gap-4">
          <h1 className="text-[26px] font-bold tracking-[-0.03em] text-foreground sm:text-[32px]">
            Audit Access Keys
          </h1>
        </div>
        <div className="mt-4 h-px bg-gradient-to-r from-primary/40 via-border/50 to-transparent" />
      </div>

      <div className="grid gap-6 pb-16 lg:grid-cols-[1fr_360px] lg:items-start">

        {/* ── Issue new key ─────────────────────────────────── */}
        <motion.section
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.32, ease: [0.22, 1, 0.36, 1] }}
          className="flex flex-col gap-6 rounded-xl border border-border/60 bg-card/40 p-6 sm:p-8"
        >
          <div className="flex items-start gap-3">
            <div className="grid size-10 shrink-0 place-items-center rounded-xl border border-primary/20 bg-primary/10 text-primary">
              <HugeiconsIcon icon={KeyIcon} size={18} strokeWidth={1.6} />
            </div>
            <div>
              <h2 className="text-[16px] font-medium tracking-tight text-foreground">
                Issue an audit access key
              </h2>
              <p className="mt-1 text-[13px] leading-5 text-muted-foreground">
                Date-ranged, read-only audit snapshot from your synced Umbra received UTXOs. Under the hood this uses an Umbra viewing key derived locally; it is never sent to any server.
              </p>
            </div>
          </div>

          {/* Form */}
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="flex flex-col gap-2 sm:col-span-2">
              <Label htmlFor="auditor">Auditor / recipient label</Label>
              <Input
                id="auditor"
                placeholder="e.g. Trail of Bits, Internal Finance"
                value={auditor}
                onChange={(e) => setAuditor(e.target.value)}
                disabled={isLoading}
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="dateFrom">From date</Label>
              <Input
                id="dateFrom"
                type="date"
                value={dateFrom}
                onChange={(e) => setDateFrom(e.target.value)}
                disabled={isLoading}
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="dateTo">To date</Label>
              <Input
                id="dateTo"
                type="date"
                value={dateTo}
                onChange={(e) => setDateTo(e.target.value)}
                disabled={isLoading}
              />
            </div>
          </div>

          {/* How it works */}
          <div className="flex flex-col gap-3 rounded-xl border border-dashed border-primary/20 bg-primary/5 p-4">
            {[
              "Sync received payments on History first so the token includes the latest Umbra scan rows.",
              "The generated token includes access metadata, date range, and a scoped UTXO snapshot for the auditor portal.",
              "Archiving an audit key removes it from this device. Already-shared snapshot tokens cannot be recalled.",
            ].map((t, i) => (
              <motion.p
                key={t}
                initial={{ opacity: 0, x: -4 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ delay: 0.16 + i * 0.05, duration: 0.25 }}
                className="flex items-start gap-2 text-[12.5px] leading-5 text-foreground/85"
              >
                <HugeiconsIcon
                  icon={CheckmarkCircle01Icon}
                  size={13}
                  strokeWidth={2}
                  className="mt-0.5 shrink-0 text-primary"
                />
                {t}
              </motion.p>
            ))}
          </div>

          {!publicKey && (
            <p className="text-[12.5px] text-amber-400">
              Connect your wallet to generate an audit access key.
            </p>
          )}

          {publicKey && !client && (
            <p className="text-[12.5px] text-amber-400">
              {isRegistering
                ? "Registering with Umbra — this is a one-time setup, please wait."
                : "Umbra client initializing — please wait a moment."}
            </p>
          )}

          {/* Error */}
          {error && (
            <p className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-[12.5px] text-destructive">
              {error}
            </p>
          )}

          {/* Token output */}
          {lastToken && (
            <div className="flex flex-col gap-2 rounded-xl border border-primary/30 bg-primary/5 p-4">
              <p className="text-[12px] font-medium text-primary">
                Audit access key ready — share this token with your auditor:
              </p>
              <div className="flex items-center gap-2">
                <code className="min-w-0 flex-1 truncate rounded-md bg-background/60 px-2 py-1.5 font-mono text-[11px] text-foreground/80">
                  {lastToken}
                </code>
                <button
                  type="button"
                  onClick={() => handleCopy(lastToken, "new")}
                  aria-label="Copy token"
                  className="shrink-0 text-muted-foreground transition-colors hover:text-primary"
                >
                  <HugeiconsIcon
                    icon={copied === "new" ? CheckmarkCircle01Icon : Copy01Icon}
                    size={14}
                    strokeWidth={1.8}
                    className={copied === "new" ? "text-primary" : ""}
                  />
                </button>
              </div>
              <p className="text-[11px] text-muted-foreground">
                Auditors paste this at{" "}
                <a
                  href="/audit"
                  className="text-primary underline-offset-2 hover:underline"
                >
                  /audit
                </a>{" "}
                to view the date-bounded snapshot. Use Export CSV below to generate the same scoped report.
              </p>
            </div>
          )}

          <FancyButton
            variant="primary"
            size="lg"
            className="self-start"
            onClick={handleGenerate}
            disabled={!canGenerate || isLoading}
          >
            {isLoading ? (
              <>
                <HugeiconsIcon
                  icon={Loading03Icon}
                  size={14}
                  strokeWidth={2.2}
                  className="animate-spin"
                />
                {stateLabel[state]}
              </>
            ) : (
              <>
                {stateLabel[state]}
                <HugeiconsIcon icon={ArrowRight01Icon} size={14} strokeWidth={2.2} />
              </>
            )}
          </FancyButton>
        </motion.section>

        {/* ── Right column ──────────────────────────────────── */}
        <div className="flex flex-col gap-6">

          {/* Active keys */}
          <motion.section
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.32, delay: 0.06, ease: [0.22, 1, 0.36, 1] }}
            className="rounded-xl border border-border/60 bg-card/40 p-6 lg:sticky lg:top-20"
          >
            <div className="flex items-center justify-between">
              <h3 className="text-[14px] font-medium tracking-tight text-foreground">
                Active audit keys
              </h3>
              <span className="font-mono text-[11px] text-muted-foreground">
                {activeKeys.length} issued
              </span>
            </div>

            {activeKeys.length === 0 ? (
              <p className="mt-4 text-[12.5px] text-muted-foreground">
                No active audit keys yet.
              </p>
            ) : (
              <ul className="mt-4 flex flex-col gap-2">
                {activeKeys.map((k, i) => {
                  const token = encodeViewingKeyToken(k);
                  return (
                    <motion.li
                      key={k.id}
                      initial={{ opacity: 0, y: 6 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ delay: 0.18 + i * 0.05, duration: 0.28 }}
                      className="group flex items-start gap-3 rounded-lg border border-border/50 bg-background/40 p-4"
                    >
                      <span className="mt-0.5 grid size-7 shrink-0 place-items-center rounded-md border border-primary/20 bg-primary/10 text-primary">
                        <HugeiconsIcon icon={EyeIcon} size={12} strokeWidth={1.8} />
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-[13px] font-medium text-foreground">
                          {k.auditor}
                        </p>
                        <p className="text-[11.5px] text-muted-foreground">
                          {k.dateFrom} → {k.dateTo}
                        </p>
                        <p className="text-[11.5px] text-muted-foreground">
                          {k.utxos?.length ?? 0} synced Umbra row{k.utxos?.length === 1 ? "" : "s"}
                        </p>
                        <p className="mt-1 truncate font-mono text-[11px] text-muted-foreground/70">
                          {token.slice(0, 20)}…
                        </p>
                      </div>

                      {/* Actions */}
                      <div className="flex shrink-0 gap-1.5">
                        <button
                          type="button"
                          aria-label="Copy token"
                          title="Copy token"
                          onClick={() => handleCopy(token, k.id)}
                          className="text-muted-foreground transition-colors hover:text-primary"
                        >
                          <HugeiconsIcon
                            icon={copied === k.id ? CheckmarkCircle01Icon : Copy01Icon}
                            size={13}
                            strokeWidth={1.8}
                            className={cn(copied === k.id && "text-primary")}
                          />
                        </button>
                        <button
                          type="button"
                          aria-label="Export CSV"
                          title="Export scoped CSV"
                          onClick={() => handleExportCsv(k)}
                          disabled={!!exporting}
                          className="text-muted-foreground transition-colors hover:text-primary disabled:opacity-50"
                        >
                          <HugeiconsIcon
                            icon={exporting === k.id ? Loading03Icon : Download01Icon}
                            size={13}
                            strokeWidth={1.8}
                            className={exporting === k.id ? "animate-spin" : ""}
                          />
                        </button>
                        <button
                          type="button"
                          aria-label="Archive key"
                          title="Archive local key"
                          onClick={() => handleRevoke(k.id)}
                          className="text-muted-foreground transition-colors hover:text-destructive"
                        >
                          <HugeiconsIcon icon={Delete02Icon} size={13} strokeWidth={1.8} />
                        </button>
                      </div>
                    </motion.li>
                  );
                })}
              </ul>
            )}
          </motion.section>

          {/* Archived keys */}
          {revokedKeys.length > 0 && (
            <motion.section
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.32, delay: 0.12, ease: [0.22, 1, 0.36, 1] }}
              className="rounded-xl border border-border/60 bg-card/40 p-6 lg:sticky lg:top-20"
            >
              <div className="flex items-center justify-between">
                <h3 className="text-[14px] font-medium tracking-tight text-foreground">
                  Archived
                </h3>
                <HugeiconsIcon
                  icon={FileSecurityIcon}
                  size={14}
                  strokeWidth={1.8}
                  className="text-muted-foreground"
                />
              </div>
              <ul className="mt-4 flex flex-col gap-2">
                {revokedKeys.map((k, i) => (
                  <motion.li
                    key={k.id}
                    initial={{ opacity: 0, y: 6 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: 0.24 + i * 0.05, duration: 0.28 }}
                    className="flex items-start gap-3 rounded-lg border border-border/50 bg-background/40 p-4 opacity-50"
                  >
                    <span className="mt-0.5 grid size-7 shrink-0 place-items-center rounded-md border border-border bg-background/60 text-muted-foreground">
                      <HugeiconsIcon icon={EyeIcon} size={12} strokeWidth={1.8} />
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[13px] font-medium text-muted-foreground line-through">
                        {k.auditor}
                      </p>
                      <p className="text-[11.5px] text-muted-foreground">
                        {k.dateFrom} → {k.dateTo}
                      </p>
                    </div>
                  </motion.li>
                ))}
              </ul>
            </motion.section>
          )}
        </div>
      </div>
    </div>
  );
}
