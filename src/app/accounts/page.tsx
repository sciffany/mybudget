"use client";

import { useEffect, useState, type FormEvent } from "react";
import {
  ACCOUNT_TYPE_LABELS,
  ACCOUNT_TYPES,
  type AccountRow,
  type AccountType,
} from "@/lib/db";

export default function AccountsPage() {
  const [rows, setRows] = useState<AccountRow[] | null>(null);
  const [name, setName] = useState("");
  const [type, setType] = useState<AccountType>("dbs");
  const [formError, setFormError] = useState("");
  const [listError, setListError] = useState("");
  const [saving, setSaving] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editName, setEditName] = useState("");
  const [busyId, setBusyId] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { listAccounts } = await import("@/lib/db");
        const accounts = await listAccounts();
        if (!cancelled) setRows(accounts);
      } catch (e) {
        if (!cancelled) setListError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleCreate(e: FormEvent) {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) {
      setFormError("Enter a name for the account.");
      return;
    }

    setSaving(true);
    setFormError("");
    try {
      const { insertAccount } = await import("@/lib/db");
      const id = await insertAccount({ name: trimmed, type });
      setRows((current) => {
        const next = [...(current ?? []), { id, name: trimmed, type }];
        next.sort((a, b) => a.name.localeCompare(b.name));
        return next;
      });
      setName("");
      setType("dbs");
    } catch (err) {
      setFormError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  function startRename(account: AccountRow) {
    setEditingId(account.id);
    setEditName(account.name);
    setListError("");
  }

  function cancelRename() {
    setEditingId(null);
    setEditName("");
  }

  async function handleRename(e: FormEvent, account: AccountRow) {
    e.preventDefault();
    const trimmed = editName.trim();
    if (!trimmed) {
      setListError("Enter a name for the account.");
      return;
    }
    if (trimmed === account.name) {
      cancelRename();
      return;
    }

    setBusyId(account.id);
    setListError("");
    try {
      const { renameAccount } = await import("@/lib/db");
      const stored = await renameAccount(account.id, trimmed);
      setRows((current) => {
        const next = (current ?? []).map((row) =>
          row.id === account.id ? { ...row, name: stored } : row,
        );
        next.sort((a, b) => a.name.localeCompare(b.name));
        return next;
      });
      cancelRename();
    } catch (err) {
      setListError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyId(null);
    }
  }

  async function handleDelete(account: AccountRow) {
    setListError("");
    try {
      const { countAccountTransactions, deleteAccount } = await import("@/lib/db");
      const count = await countAccountTransactions(account.id);
      const linked =
        count === 0
          ? "No transactions are linked to it."
          : count === 1
            ? "1 transaction will stay, but it will no longer be linked to this account."
            : `${count} transactions will stay, but they will no longer be linked to this account.`;
      if (
        !window.confirm(
          `Delete "${account.name}"? ${linked} This cannot be undone.`,
        )
      ) {
        return;
      }

      setBusyId(account.id);
      await deleteAccount(account.id);
      setRows((current) => current?.filter((row) => row.id !== account.id) ?? current);
      if (editingId === account.id) cancelRename();
    } catch (err) {
      setListError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyId(null);
    }
  }

  const busy = saving || busyId !== null;

  return (
    <main className="mx-auto flex max-w-6xl flex-col gap-6 px-4 py-6 sm:gap-8 sm:px-6 sm:py-10">
      <section className="flex flex-col gap-4 rounded-xl border border-zinc-200 bg-white p-4 sm:p-5 dark:border-zinc-800 dark:bg-zinc-900">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-500">
          New account
        </h2>
        <form onSubmit={handleCreate} className="flex flex-wrap items-end gap-3">
          <label className="flex min-w-48 flex-1 flex-col gap-1 text-sm">
            <span className="font-medium text-zinc-700 dark:text-zinc-300">
              Name
            </span>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Everyday savings"
              disabled={saving}
              className="rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-950"
            />
          </label>
          <label className="flex w-full flex-col gap-1 text-sm sm:w-44">
            <span className="font-medium text-zinc-700 dark:text-zinc-300">
              Type
            </span>
            <select
              value={type}
              onChange={(e) => setType(e.target.value as AccountType)}
              disabled={saving}
              className="rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-950"
            >
              {ACCOUNT_TYPES.map((accountType) => (
                <option key={accountType} value={accountType}>
                  {ACCOUNT_TYPE_LABELS[accountType]}
                </option>
              ))}
            </select>
          </label>
          <button
            type="submit"
            disabled={saving}
            className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-40"
          >
            {saving ? "Saving..." : "Create account"}
          </button>
        </form>
        {formError && (
          <p className="text-sm text-red-600 dark:text-red-400">{formError}</p>
        )}
      </section>

      <section className="flex flex-col gap-4 rounded-xl border border-zinc-200 bg-white p-4 sm:p-5 dark:border-zinc-800 dark:bg-zinc-900">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-500">
          Accounts{rows ? ` (${rows.length})` : ""}
        </h2>

        {listError && (
          <p className="text-sm text-red-600 dark:text-red-400">{listError}</p>
        )}

        {rows === null && !listError && (
          <p className="text-sm text-zinc-600 dark:text-zinc-400">Loading…</p>
        )}

        {rows && rows.length === 0 && (
          <p className="text-sm text-zinc-600 dark:text-zinc-400">
            No accounts yet. Create one above.
          </p>
        )}

        {rows && rows.length > 0 && (
          <ul className="divide-y divide-zinc-200 dark:divide-zinc-800">
            {rows.map((account) => {
              const typeLabel = ACCOUNT_TYPE_LABELS[account.type] ?? account.type;
              const rowClass = "flex flex-wrap items-center gap-x-3 gap-y-2 py-3 text-sm";

              if (editingId === account.id) {
                return (
                  <li key={account.id}>
                    <form
                      onSubmit={(e) => handleRename(e, account)}
                      className={rowClass}
                    >
                      <input
                        value={editName}
                        onChange={(e) => setEditName(e.target.value)}
                        disabled={busyId === account.id}
                        aria-label={`Name for ${account.name}`}
                        className="min-w-40 flex-1 rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-950"
                      />
                      <span className="text-zinc-500">{typeLabel}</span>
                      <button
                        type="submit"
                        disabled={busyId === account.id}
                        className="rounded-md bg-blue-600 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-40"
                      >
                        {busyId === account.id ? "Saving..." : "Save"}
                      </button>
                      <button
                        type="button"
                        onClick={cancelRename}
                        disabled={busyId === account.id}
                        className="rounded-md border border-zinc-300 px-3 py-1.5 text-xs font-medium disabled:opacity-40 dark:border-zinc-700"
                      >
                        Cancel
                      </button>
                    </form>
                  </li>
                );
              }

              return (
                <li key={account.id} className={rowClass}>
                  <span className="min-w-0 flex-1 font-medium">{account.name}</span>
                  <span className="text-zinc-500">{typeLabel}</span>
                  <button
                    type="button"
                    onClick={() => startRename(account)}
                    disabled={busy}
                    className="rounded-md border border-zinc-300 px-3 py-1.5 text-xs font-medium disabled:opacity-40 dark:border-zinc-700"
                  >
                    Rename
                  </button>
                  <button
                    type="button"
                    onClick={() => handleDelete(account)}
                    disabled={busy}
                    className="rounded-md border border-red-300 px-3 py-1.5 text-xs font-medium text-red-700 disabled:opacity-40 dark:border-red-800 dark:text-red-400"
                  >
                    {busyId === account.id ? "Deleting..." : "Delete"}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </main>
  );
}
