"use client";

import { useState, type ChangeEvent } from "react";

export default function SettingsPage() {
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

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
      setStatus(`Restored database from "${backup.name}"`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="mx-auto flex max-w-6xl flex-col gap-8 px-6 py-12">
      <section className="flex flex-col gap-4 rounded-xl border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-500">
          Database
        </h2>
        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          Data lives only in this browser. Download a backup to keep it safe
          from clearing your browser or to move it to another device.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={handleDownloadBackup}
            disabled={busy}
            className="rounded-md border border-zinc-300 px-3 py-1.5 text-xs font-medium disabled:opacity-40 dark:border-zinc-700"
          >
            {busy ? "Working..." : "Download backup"}
          </button>
          <label className="cursor-pointer rounded-md border border-zinc-300 px-3 py-1.5 text-xs font-medium dark:border-zinc-700">
            Restore backup
            <input
              type="file"
              accept=".sqlite,application/x-sqlite3,application/octet-stream"
              onChange={handleRestoreBackup}
              disabled={busy}
              className="hidden"
            />
          </label>
        </div>
        {status && (
          <p className="text-sm text-zinc-600 dark:text-zinc-400">{status}</p>
        )}
        {error && (
          <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
        )}
      </section>
    </main>
  );
}
