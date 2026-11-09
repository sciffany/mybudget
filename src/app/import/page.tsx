"use client";

import { useState } from "react";
import type { ParsedStatement } from "@/lib/statements";

/** Convert a formatted amount like "1,234.56" into integer cents. */
function toCents(amount: string): number | null {
  const n = Number(amount.replace(/,/g, ""));
  if (!Number.isFinite(n)) return null;
  return Math.round(Math.abs(n) * 100);
}

/** Convert a DBS date "DD/MM/YYYY" into an ISO "YYYY-MM-DD" date. */
function toIsoDate(date: string): string {
  const [dd, mm, yyyy] = date.split("/");
  return `${yyyy}-${mm}-${dd}`;
}

/** SHA-256 hex of the PDF bytes. This is the import's duplicate key. */
async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes.slice());
  return Array.from(new Uint8Array(digest), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}

export default function ImportPage() {
  const [file, setFile] = useState<File | null>(null);

  const [status, setStatus] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>("");

  const [txnResult, setTxnResult] = useState<ParsedStatement | null>(null);
  const [fileHash, setFileHash] = useState<string | null>(null);
  const [alreadyImported, setAlreadyImported] = useState(false);

  async function parseFile(next: File) {
    setFile(next);
    setBusy(true);
    setError("");
    setTxnResult(null);
    setFileHash(null);
    setAlreadyImported(false);
    try {
      const bytes = new Uint8Array(await next.arrayBuffer());
      const hash = await sha256Hex(bytes);
      const { findImportByFileHash } = await import("@/lib/db");
      const existing = await findImportByFileHash(hash);
      const { parseStatement } = await import("@/lib/statements");
      const res = await parseStatement(bytes, setStatus);
      setFileHash(hash);
      setTxnResult(res);
      if (existing) {
        setAlreadyImported(true);
        setError(
          `This PDF was already imported (${existing.filename}, ${existing.created_at}).`,
        );
      }
      setStatus(
        `Parsed ${res.transactions.length} ${res.accountType} transaction(s) across ${res.pageCount} page(s)`,
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStatus("");
    } finally {
      setBusy(false);
    }
  }

  async function handleSave() {
    if (!txnResult || !fileHash || alreadyImported) return;
    setBusy(true);
    setError("");
    try {
      const { saveImport } = await import("@/lib/db");
      const transactions = txnResult.transactions.flatMap((t) => {
        const amount = toCents(t.amount);
        if (amount === null) return []; // skip rows without a parseable amount
        return [
          {
            date: toIsoDate(t.date),
            amount,
            type: t.transactionType,
            description: t.description,
          },
        ];
      });
      await saveImport({
        filename: file?.name ?? "statement.pdf",
        fileHash,
        pageCount: txnResult.pageCount,
        accountType: txnResult.accountType,
        transactions,
      });
      setAlreadyImported(true);
      setStatus(
        `Saved ${transactions.length} transaction(s) to your local database`,
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="mx-auto flex max-w-6xl flex-col gap-8 px-6 py-12">
      <section className="flex flex-col gap-4 rounded-xl border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-500">
          Import
        </h2>
        <div className="flex flex-wrap items-center gap-3">
          {txnResult ? (
            <button
              onClick={handleSave}
              disabled={busy || alreadyImported || !fileHash}
              className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-40"
            >
              {busy
                ? "Working..."
                : alreadyImported
                  ? "Already imported"
                  : "Save to transactions"}
            </button>
          ) : (
            <label className="inline-flex cursor-pointer items-center rounded-md border border-zinc-300 bg-zinc-50 px-4 py-2 text-sm font-medium hover:bg-zinc-100 dark:border-zinc-700 dark:bg-zinc-800 dark:hover:bg-zinc-700">
              {busy ? "Working..." : "Choose file"}
              <input
                type="file"
                accept="application/pdf"
                disabled={busy}
                onChange={(e) => {
                  const next = e.target.files?.[0];
                  e.target.value = "";
                  if (next) void parseFile(next);
                }}
                className="hidden"
              />
            </label>
          )}
          <span className="text-sm text-zinc-600 dark:text-zinc-400">
            {file ? file.name : "No file chosen"}
          </span>
        </div>

        {status && (
          <p className="text-sm text-zinc-600 dark:text-zinc-400">{status}</p>
        )}
        {error && (
          <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
        )}
      </section>

      {txnResult && (
        <section className="flex flex-col gap-4 rounded-xl border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-500">
            Transactions ({txnResult.transactions.length})
          </h2>
          {txnResult.transactions.length === 0 ? (
            <p className="text-sm text-zinc-600 dark:text-zinc-400">
              No transactions found in this {txnResult.accountType} statement.
            </p>
          ) : (
            <div className="overflow-x-auto rounded-md border border-zinc-200 dark:border-zinc-800">
              <table className="w-full border-collapse text-sm">
                <thead>
                  <tr className="bg-zinc-100 text-left font-medium dark:bg-zinc-800">
                    <th className="px-2 py-1">Date</th>
                    <th className="px-2 py-1">Description</th>
                    <th className="px-2 py-1 text-right">Amount</th>
                    <th className="px-2 py-1">Type</th>
                  </tr>
                </thead>
                <tbody>
                  {txnResult.transactions.map((t, i) => (
                    <tr key={i} className="odd:bg-zinc-50 dark:odd:bg-zinc-900">
                      <td className="whitespace-nowrap px-2 py-1 align-top">
                        {t.date}
                      </td>
                      <td className="px-2 py-1 align-top">{t.description}</td>
                      <td
                        className={`whitespace-nowrap px-2 py-1 text-right align-top ${
                          t.transactionType === "debit"
                            ? "text-red-600 dark:text-red-400"
                            : "text-green-600 dark:text-green-400"
                        }`}
                      >
                        {t.amount}
                      </td>
                      <td className="whitespace-nowrap px-2 py-1 align-top capitalize">
                        {t.transactionType}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}
    </main>
  );
}
