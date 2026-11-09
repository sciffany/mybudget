"use client";

import { useEffect, useMemo, useState } from "react";
import type { TransactionRow } from "@/lib/db";

const PAGE_SIZE = 200;
const NONE = "none";

const money = new Intl.NumberFormat("en-SG", {
  style: "currency",
  currency: "SGD",
});

const fieldClass =
  "rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-950";

function formatMonth(yearMonth: string): string {
  const [year, month] = yearMonth.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, 1)).toLocaleDateString("en-SG", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

function uniqueOptions(
  rows: TransactionRow[],
  idOf: (row: TransactionRow) => number | null,
  nameOf: (row: TransactionRow) => string | null,
  emptyLabel: string,
): [string, string][] {
  const named = new Map<string, string>();
  let hasEmpty = false;
  for (const row of rows) {
    const id = idOf(row);
    if (id == null) hasEmpty = true;
    else named.set(String(id), nameOf(row) ?? "Untitled");
  }
  const options = [...named.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  if (hasEmpty) options.unshift([NONE, emptyLabel]);
  return options;
}

function formatAmount(cents: number, type: TransactionRow["type"]): string {
  const value = cents / 100;
  const formatted = money.format(value);
  return type === "debit" ? `-${formatted}` : formatted;
}

export default function TransactionsPage() {
  const [rows, setRows] = useState<TransactionRow[] | null>(null);
  const [error, setError] = useState("");
  const [page, setPage] = useState(0);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [deleting, setDeleting] = useState(false);
  const [month, setMonth] = useState("");
  const [category, setCategory] = useState("");
  const [account, setAccount] = useState("");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { listTransactions } = await import("@/lib/db");
        const transactions = await listTransactions();
        if (!cancelled) setRows(transactions);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const months = useMemo(() => {
    if (!rows) return [];
    return [...new Set(rows.map((t) => t.date.slice(0, 7)))].sort().reverse();
  }, [rows]);

  const categories = useMemo(
    () =>
      rows
        ? uniqueOptions(rows, (t) => t.category_id, (t) => t.category_name, "Uncategorized")
        : [],
    [rows],
  );

  const accounts = useMemo(
    () =>
      rows
        ? uniqueOptions(rows, (t) => t.account_id, (t) => t.account_name, "No account")
        : [],
    [rows],
  );

  const filtered = useMemo(() => {
    if (!rows) return [];
    return rows.filter((t) => {
      if (month && t.date.slice(0, 7) !== month) return false;
      if (category === NONE && t.category_id != null) return false;
      if (category && category !== NONE && String(t.category_id) !== category) return false;
      if (account === NONE && t.account_id != null) return false;
      if (account && account !== NONE && String(t.account_id) !== account) return false;
      return true;
    });
  }, [rows, month, category, account]);

  const filtersActive = month !== "" || category !== "" || account !== "";
  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const safePage = Math.min(page, pageCount - 1);
  const pageRows = useMemo(() => {
    const start = safePage * PAGE_SIZE;
    return filtered.slice(start, start + PAGE_SIZE);
  }, [filtered, safePage]);

  useEffect(() => {
    if (page !== safePage) setPage(safePage);
  }, [page, safePage]);

  const allOnPageSelected =
    pageRows.length > 0 && pageRows.every((t) => selected.has(t.id));
  const someOnPageSelected = pageRows.some((t) => selected.has(t.id));
  const rangeStart = filtered.length > 0 ? safePage * PAGE_SIZE + 1 : 0;
  const rangeEnd = Math.min(filtered.length, (safePage + 1) * PAGE_SIZE);

  function applyFilter(setter: (value: string) => void, value: string) {
    setter(value);
    setPage(0);
    setSelected(new Set());
  }

  function clearFilters() {
    setMonth("");
    setCategory("");
    setAccount("");
    setPage(0);
    setSelected(new Set());
  }

  function toggleOne(id: number) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function togglePage() {
    setSelected((prev) => {
      const next = new Set(prev);
      if (allOnPageSelected) {
        for (const t of pageRows) next.delete(t.id);
      } else {
        for (const t of pageRows) next.add(t.id);
      }
      return next;
    });
  }

  async function handleDelete() {
    if (selected.size === 0) return;
    const count = selected.size;
    const noun = count === 1 ? "transaction" : "transactions";
    if (!window.confirm(`Delete ${count} ${noun}? This cannot be undone.`)) return;

    setDeleting(true);
    setError("");
    try {
      const { deleteTransactions } = await import("@/lib/db");
      const ids = [...selected];
      await deleteTransactions(ids);
      const removed = new Set(ids);
      setRows((current) => current?.filter((t) => !removed.has(t.id)) ?? current);
      setSelected(new Set());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setDeleting(false);
    }
  }

  return (
    <main className="mx-auto flex max-w-6xl flex-col gap-8 px-6 py-12">
      <section className="flex flex-col gap-4 rounded-xl border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-500">
          Transactions
          {rows
            ? filtersActive
              ? ` (${filtered.length} of ${rows.length})`
              : ` (${rows.length})`
            : ""}
        </h2>

        {error && (
          <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
        )}

        {rows === null && !error && (
          <p className="text-sm text-zinc-600 dark:text-zinc-400">Loading…</p>
        )}

        {rows && rows.length === 0 && (
          <p className="text-sm text-zinc-600 dark:text-zinc-400">
            No transactions yet. Import a statement to add some.
          </p>
        )}

        {rows && rows.length > 0 && (
          <div className="flex flex-col gap-3">
            <div className="flex flex-wrap items-end gap-3">
              <label className="flex min-w-40 flex-col gap-1 text-sm">
                <span className="font-medium text-zinc-700 dark:text-zinc-300">Month</span>
                <select
                  value={month}
                  onChange={(e) => applyFilter(setMonth, e.target.value)}
                  className={fieldClass}
                >
                  <option value="">All months</option>
                  {months.map((value) => (
                    <option key={value} value={value}>
                      {formatMonth(value)}
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex min-w-40 flex-col gap-1 text-sm">
                <span className="font-medium text-zinc-700 dark:text-zinc-300">Category</span>
                <select
                  value={category}
                  onChange={(e) => applyFilter(setCategory, e.target.value)}
                  className={fieldClass}
                >
                  <option value="">All categories</option>
                  {categories.map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex min-w-40 flex-col gap-1 text-sm">
                <span className="font-medium text-zinc-700 dark:text-zinc-300">Account</span>
                <select
                  value={account}
                  onChange={(e) => applyFilter(setAccount, e.target.value)}
                  className={fieldClass}
                >
                  <option value="">All accounts</option>
                  {accounts.map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
              {filtersActive && (
                <button
                  type="button"
                  onClick={clearFilters}
                  className="rounded-md border border-zinc-300 px-3 py-2 text-sm font-medium dark:border-zinc-700"
                >
                  Clear filters
                </button>
              )}
            </div>

            {filtered.length === 0 && (
              <p className="text-sm text-zinc-600 dark:text-zinc-400">
                No transactions match these filters.
              </p>
            )}

            {filtered.length > 0 && (
            <>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-sm text-zinc-600 dark:text-zinc-400">
                Showing {rangeStart}–{rangeEnd} of {filtered.length}
              </p>
              <button
                type="button"
                onClick={handleDelete}
                disabled={selected.size === 0 || deleting}
                className="rounded-md border border-red-300 px-3 py-1.5 text-xs font-medium text-red-700 disabled:opacity-40 dark:border-red-800 dark:text-red-400"
              >
                {deleting
                  ? "Deleting…"
                  : `Delete selected${selected.size > 0 ? ` (${selected.size})` : ""}`}
              </button>
            </div>
            <div className="overflow-x-auto rounded-md border border-zinc-200 dark:border-zinc-800">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr className="bg-zinc-100 text-left font-medium dark:bg-zinc-800">
                  <th className="w-8 px-2 py-1">
                    <input
                      type="checkbox"
                      checked={allOnPageSelected}
                      ref={(el) => {
                        if (el) el.indeterminate = someOnPageSelected && !allOnPageSelected;
                      }}
                      onChange={togglePage}
                      aria-label="Select all transactions on this page"
                    />
                  </th>
                  <th className="px-2 py-1">Date</th>
                  <th className="px-2 py-1">Description</th>
                  <th className="px-2 py-1 text-right">Amount</th>
                  <th className="px-2 py-1">Category</th>
                  <th className="px-2 py-1">Umbrella</th>
                  <th className="px-2 py-1">Account</th>
                </tr>
              </thead>
              <tbody>
                {pageRows.map((t) => (
                  <tr key={t.id} className="odd:bg-zinc-50 dark:odd:bg-zinc-900">
                    <td className="px-2 py-1 align-top">
                      <input
                        type="checkbox"
                        checked={selected.has(t.id)}
                        onChange={() => toggleOne(t.id)}
                        aria-label={`Select transaction ${t.date} ${t.description}`}
                      />
                    </td>
                    <td className="whitespace-nowrap px-2 py-1 align-top">
                      {t.date}
                    </td>
                    <td className="px-2 py-1 align-top">{t.description}</td>
                    <td
                      className={`whitespace-nowrap px-2 py-1 text-right align-top ${
                        t.type === "debit"
                          ? "text-red-600 dark:text-red-400"
                          : "text-green-600 dark:text-green-400"
                      }`}
                    >
                      {formatAmount(t.amount, t.type)}
                    </td>
                    <td className="whitespace-nowrap px-2 py-1 align-top">
                      {t.category_name ?? ""}
                    </td>
                    <td className="whitespace-nowrap px-2 py-1 align-top">
                      {t.umbrella_name ?? ""}
                    </td>
                    <td className="whitespace-nowrap px-2 py-1 align-top">
                      {t.account_name ?? ""}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            </div>
            {pageCount > 1 && (
              <div className="flex items-center justify-between gap-2">
                <button
                  type="button"
                  onClick={() => setPage((p) => Math.max(0, p - 1))}
                  disabled={safePage === 0}
                  className="rounded-md border border-zinc-300 px-3 py-1.5 text-xs font-medium disabled:opacity-40 dark:border-zinc-700"
                >
                  Previous
                </button>
                <p className="text-sm text-zinc-600 dark:text-zinc-400">
                  Page {safePage + 1} of {pageCount}
                </p>
                <button
                  type="button"
                  onClick={() => setPage((p) => Math.min(pageCount - 1, p + 1))}
                  disabled={safePage >= pageCount - 1}
                  className="rounded-md border border-zinc-300 px-3 py-1.5 text-xs font-medium disabled:opacity-40 dark:border-zinc-700"
                >
                  Next
                </button>
              </div>
            )}
            </>
            )}
          </div>
        )}
      </section>
    </main>
  );
}
