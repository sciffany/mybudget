"use client";

import { useEffect, useState, type ChangeEvent } from "react";
import type { ParseResult } from "@/lib/pdfjs-dbs";
import type { DocumentRow } from "@/lib/db";

export default function ImportPage() {
  const [file, setFile] = useState<File | null>(null);

  const [status, setStatus] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>("");

  const [txnResult, setTxnResult] = useState<ParseResult | null>(null);
  const [documents, setDocuments] = useState<DocumentRow[]>([]);

  // Load the saved document list on mount (browser only).
  useEffect(() => {
    void refreshDocuments();
  }, []);

  async function refreshDocuments() {
    try {
      const { listDocuments } = await import("@/lib/db");
      setDocuments(await listDocuments());
    } catch (e) {
      // Non-fatal: the DB may not be initialized yet.
      console.error(e);
    }
  }

  async function handleParseTransactions() {
    if (!file) return;
    setBusy(true);
    setError("");
    setTxnResult(null);
    try {
      const { parseDbsStatement } = await import("@/lib/pdfjs-dbs");
      const bytes = new Uint8Array(await file.arrayBuffer());
      const res = await parseDbsStatement(bytes, setStatus);
      setTxnResult(res);
      setStatus(
        `Parsed ${res.transactions.length} transaction(s) across ${res.pageCount} page(s)`,
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStatus("");
    } finally {
      setBusy(false);
    }
  }

  async function handleSave() {
    if (!file || !txnResult) return;
    setBusy(true);
    setError("");
    try {
      const { insertDocument } = await import("@/lib/db");
      // Serialize the parsed transactions into a tab-separated text blob so the
      // document store keeps a readable record of what was extracted.
      const text = txnResult.transactions
        .map((t) =>
          [
            t.date,
            t.account ?? "",
            t.description,
            t.withdrawal,
            t.deposit,
            t.balance,
          ].join("\t"),
        )
        .join("\n");
      await insertDocument({
        filename: file.name,
        pageCount: txnResult.pageCount,
        text,
      });
      await refreshDocuments();
      setStatus(`Saved "${file.name}" to your local database`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function handleDownloadBackup() {
    setBusy(true);
    setError("");
    try {
      const { exportDatabase } = await import("@/lib/db");
      const bytes = await exportDatabase();
      // Copy into a fresh ArrayBuffer so the Blob gets a clean slice.
      const buf = bytes.slice().buffer;
      const url = URL.createObjectURL(
        new Blob([buf], { type: "application/x-sqlite3" }),
      );
      const a = document.createElement("a");
      a.href = url;
      a.download = "budget.sqlite";
      a.click();
      URL.revokeObjectURL(url);
      setStatus("Backup downloaded as budget.sqlite");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function handleRestoreBackup(e: ChangeEvent<HTMLInputElement>) {
    const backup = e.target.files?.[0];
    e.target.value = ""; // allow re-selecting the same file later
    if (!backup) return;
    setBusy(true);
    setError("");
    try {
      const { importDatabase } = await import("@/lib/db");
      const bytes = new Uint8Array(await backup.arrayBuffer());
      await importDatabase(bytes);
      await refreshDocuments();
      setStatus(`Restored database from "${backup.name}"`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="mx-auto flex max-w-6xl flex-col gap-8 px-6 py-12">
      {/* Step 1: choose a PDF */}
      <section className="flex flex-col gap-4 rounded-xl border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-500">
          1. Choose a PDF
        </h2>
        <div className="flex flex-wrap items-center gap-3">
          <label className="inline-flex cursor-pointer items-center rounded-md border border-zinc-300 bg-zinc-50 px-4 py-2 text-sm font-medium hover:bg-zinc-100 dark:border-zinc-700 dark:bg-zinc-800 dark:hover:bg-zinc-700">
            Choose file
            <input
              type="file"
              accept="application/pdf"
              onChange={(e) => {
                setFile(e.target.files?.[0] ?? null);
                setTxnResult(null);
              }}
              className="hidden"
            />
          </label>
          <span className="text-sm text-zinc-600 dark:text-zinc-400">
            {file ? file.name : "No file chosen"}
          </span>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <button
            onClick={handleParseTransactions}
            disabled={!file || busy}
            className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-40"
          >
            {busy ? "Working..." : "Parse transactions"}
          </button>
          <button
            onClick={handleSave}
            disabled={!txnResult || busy}
            className="rounded-md border border-zinc-300 px-4 py-2 text-sm font-medium disabled:opacity-40 dark:border-zinc-700"
          >
            Save to local database
          </button>
        </div>

        {status && (
          <p className="text-sm text-zinc-600 dark:text-zinc-400">{status}</p>
        )}
        {error && (
          <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
        )}
      </section>

      {/* Transactions parsed with pure frontend JS (pdf.js) */}
      {txnResult && (
        <section className="flex flex-col gap-4 rounded-xl border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-500">
            Transactions ({txnResult.transactions.length}) · parsed in-browser
            with pdf.js
          </h2>
          {txnResult.transactions.length === 0 ? (
            <p className="text-sm text-zinc-600 dark:text-zinc-400">
              No transactions found. This parser expects a DBS/POSB consolidated
              statement.
            </p>
          ) : (
            <div className="overflow-x-auto rounded-md border border-zinc-200 dark:border-zinc-800">
              <table className="w-full border-collapse text-sm">
                <thead>
                  <tr className="bg-zinc-100 text-left font-medium dark:bg-zinc-800">
                    <th className="px-2 py-1">Date</th>
                    <th className="px-2 py-1">Account</th>
                    <th className="px-2 py-1">Description</th>
                    <th className="px-2 py-1 text-right">Withdrawal</th>
                    <th className="px-2 py-1 text-right">Deposit</th>
                    <th className="px-2 py-1 text-right">Balance</th>
                  </tr>
                </thead>
                <tbody>
                  {txnResult.transactions.map((t, i) => (
                    <tr key={i} className="odd:bg-zinc-50 dark:odd:bg-zinc-900">
                      <td className="whitespace-nowrap px-2 py-1 align-top">
                        {t.date}
                      </td>
                      <td className="whitespace-nowrap px-2 py-1 align-top text-xs text-zinc-500">
                        {t.account}
                      </td>
                      <td className="px-2 py-1 align-top">{t.description}</td>
                      <td className="whitespace-nowrap px-2 py-1 text-right align-top text-red-600 dark:text-red-400">
                        {t.withdrawal}
                      </td>
                      <td className="whitespace-nowrap px-2 py-1 text-right align-top text-green-600 dark:text-green-400">
                        {t.deposit}
                      </td>
                      <td className="whitespace-nowrap px-2 py-1 text-right align-top">
                        {t.balance}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      {/* Step 3: saved documents + backup */}
      <section className="flex flex-col gap-4 rounded-xl border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-500">
            2. Saved documents ({documents.length})
          </h2>
          <div className="flex flex-wrap items-center gap-2">
            <button
              onClick={handleDownloadBackup}
              disabled={busy}
              className="rounded-md border border-zinc-300 px-3 py-1.5 text-xs font-medium disabled:opacity-40 dark:border-zinc-700"
            >
              Download backup
            </button>
            <label className="cursor-pointer rounded-md border border-zinc-300 px-3 py-1.5 text-xs font-medium dark:border-zinc-700">
              Restore backup
              <input
                type="file"
                accept=".sqlite,application/x-sqlite3,application/octet-stream"
                onChange={handleRestoreBackup}
                className="hidden"
              />
            </label>
          </div>
        </div>

        {documents.length === 0 ? (
          <p className="text-sm text-zinc-600 dark:text-zinc-400">
            Nothing saved yet. Parse a PDF and click &quot;Save&quot;.
          </p>
        ) : (
          <ul className="flex flex-col divide-y divide-zinc-100 dark:divide-zinc-800">
            {documents.map((doc) => (
              <li
                key={doc.id}
                className="flex items-center justify-between py-2 text-sm"
              >
                <span className="truncate font-medium">{doc.filename}</span>
                <span className="shrink-0 pl-4 text-xs text-zinc-500">
                  {doc.page_count} pages · {doc.created_at}
                </span>
              </li>
            ))}
          </ul>
        )}
        <p className="text-xs text-zinc-500">
          Data lives only in this browser. Download a backup to keep it safe
          from clearing your browser or to move it to another device.
        </p>
      </section>
    </main>
  );
}
