"use client";

import { useState, type ChangeEvent } from "react";

export default function SettingsPage() {
  const [status, setStatus] = useState("");
  const [statusSection, setStatusSection] = useState<"database" | "danger">(
    "database",
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [confirmReset, setConfirmReset] = useState(false);

  function report(section: "database" | "danger", message: string) {
    setStatusSection(section);
    setStatus(message);
    setError("");
  }

  async function handleDownloadBackup() {
    setBusy(true);
    setError("");
    setStatus("");
    setStatusSection("database");
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
      report("database", "Backup downloaded as budget.sqlite");
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
    setStatus("");
    setStatusSection("database");
    try {
      const { importDatabase } = await import("@/lib/db");
      const bytes = new Uint8Array(await backup.arrayBuffer());
      await importDatabase(bytes);
      report("database", `Restored database from "${backup.name}"`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function handleReset() {
    setBusy(true);
    setError("");
    setStatus("");
    setStatusSection("danger");
    try {
      const { resetDatabase } = await import("@/lib/db");
      await resetDatabase();
      setConfirmReset(false);
      report("danger", "All data deleted. Preset categories and rules restored.");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="mx-auto flex max-w-6xl flex-col gap-6 px-4 py-6 sm:gap-8 sm:px-6 sm:py-10">
      <section className="flex flex-col gap-4 rounded-xl border border-zinc-200 bg-white p-4 sm:p-5 dark:border-zinc-800 dark:bg-zinc-900">
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
        {statusSection === "database" && status && (
          <p className="text-sm text-zinc-600 dark:text-zinc-400">{status}</p>
        )}
        {statusSection === "database" && error && (
          <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
        )}
      </section>

      <section className="flex flex-col gap-4 rounded-xl border border-red-200 bg-white p-4 sm:p-5 dark:border-red-900/60 dark:bg-zinc-900">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-red-600 dark:text-red-400">
          Danger
        </h2>
        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          Delete every account, transaction, import, and rule stored in this
          browser. Preset categories and rules are put back. Download a backup first if
          you want to keep this data.
        </p>
        {confirmReset ? (
          <div className="flex flex-wrap items-center gap-2">
            <button
              onClick={handleReset}
              disabled={busy}
              className="rounded-md bg-red-600 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-40"
            >
              {busy ? "Working..." : "Delete all data"}
            </button>
            <button
              onClick={() => setConfirmReset(false)}
              disabled={busy}
              className="rounded-md border border-zinc-300 px-3 py-1.5 text-xs font-medium disabled:opacity-40 dark:border-zinc-700"
            >
              Cancel
            </button>
          </div>
        ) : (
          <div>
            <button
              onClick={() => {
                setConfirmReset(true);
                setError("");
                setStatus("");
              }}
              disabled={busy}
              className="rounded-md border border-red-300 px-3 py-1.5 text-xs font-medium text-red-700 disabled:opacity-40 dark:border-red-800 dark:text-red-400"
            >
              Reset to defaults
            </button>
          </div>
        )}
        {statusSection === "danger" && status && (
          <p className="text-sm text-zinc-600 dark:text-zinc-400">{status}</p>
        )}
        {statusSection === "danger" && error && (
          <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
        )}
      </section>
    </main>
  );
}
