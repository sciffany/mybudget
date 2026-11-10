"use client";

import { Suspense, useEffect, useMemo, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import type { CategoryRow, TransactionRow, UmbrellaCategoryRow } from "@/lib/db";

const PAGE_SIZE = 200;
const NONE = "none";

const money = new Intl.NumberFormat("en-SG", {
  style: "currency",
  currency: "SGD",
});

const fieldClass =
  "w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-950";
const rowSelectClass =
  "w-full max-w-44 rounded-md border border-zinc-300 bg-white px-2 py-1 text-xs dark:border-zinc-700 dark:bg-zinc-950";
const rowDateClass =
  "rounded-md border border-zinc-300 bg-white px-2 py-1 text-xs dark:border-zinc-700 dark:bg-zinc-950";

function sortTransactions(list: TransactionRow[]): TransactionRow[] {
  return [...list].sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? 1 : -1;
    return b.id - a.id;
  });
}

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

const pageShell =
  "mx-auto flex max-w-6xl flex-col gap-6 px-4 py-6 sm:gap-8 sm:px-6 sm:py-10";

export default function TransactionsPage() {
  return (
    <Suspense
      fallback={
        <main className={pageShell}>
          <p className="text-sm text-zinc-600 dark:text-zinc-400">Loading…</p>
        </main>
      }
    >
      <TransactionsView />
    </Suspense>
  );
}

function TransactionsView() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const month = searchParams.get("month") ?? "";
  const category = searchParams.get("category") ?? "";
  const account = searchParams.get("account") ?? "";
  const filterKey = `${month}\0${category}\0${account}`;

  const [rows, setRows] = useState<TransactionRow[] | null>(null);
  const [error, setError] = useState("");
  const [page, setPage] = useState(0);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [deleting, setDeleting] = useState(false);
  const [seenFilter, setSeenFilter] = useState(filterKey);
  if (filterKey !== seenFilter) {
    setSeenFilter(filterKey);
    setPage(0);
    setSelected(new Set());
  }
  const [categories, setCategories] = useState<CategoryRow[]>([]);
  const [umbrellas, setUmbrellas] = useState<UmbrellaCategoryRow[]>([]);
  const [assignCategory, setAssignCategory] = useState("");
  const [categorizing, setCategorizing] = useState(false);
  const [notice, setNotice] = useState("");
  const [savingDateId, setSavingDateId] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { listCategories, listTransactions, listUmbrellaCategories } = await import(
          "@/lib/db"
        );
        const [transactions, loadedCategories, loadedUmbrellas] = await Promise.all([
          listTransactions(),
          listCategories(),
          listUmbrellaCategories(),
        ]);
        if (!cancelled) {
          setRows(transactions);
          setCategories(loadedCategories);
          setUmbrellas(loadedUmbrellas);
        }
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

  const categoryFilters = useMemo(
    () =>
      rows
        ? uniqueOptions(rows, (t) => t.category_id, (t) => t.category_name, "Uncategorized")
        : [],
    [rows],
  );

  const categoryGroups = useMemo(() => {
    const byUmbrella = new Map<number, CategoryRow[]>();
    for (const item of categories) {
      const group = byUmbrella.get(item.umbrella_id) ?? [];
      group.push(item);
      byUmbrella.set(item.umbrella_id, group);
    }
    const umbrellaName = new Map(umbrellas.map((row) => [row.id, row.name]));
    return [...byUmbrella.entries()]
      .map(([id, items]) => ({
        id,
        name: umbrellaName.get(id) ?? "Ungrouped",
        items,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [categories, umbrellas]);

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

  function writeFilters(next: { month?: string; category?: string; account?: string }) {
    const params = new URLSearchParams(searchParams.toString());
    const values = { month, category, account, ...next };
    for (const [key, value] of Object.entries(values)) {
      if (value) params.set(key, value);
      else params.delete(key);
    }
    const query = params.toString();
    router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
  }

  function clearFilters() {
    writeFilters({ month: "", category: "", account: "" });
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

  async function assignTo(ids: number[], categoryId: number | null): Promise<boolean> {
    if (ids.length === 0) return false;
    setCategorizing(true);
    setError("");
    setNotice("");
    const previous = rows;
    const before = new Map((rows ?? []).map((t) => [t.id, t.category_id]));
    const chosen = categories.find((item) => item.id === categoryId);
    const umbrella = umbrellas.find((item) => item.id === chosen?.umbrella_id);
    const idSet = new Set(ids);
    if (categoryId == null || chosen) {
      setRows(
        (current) =>
          current?.map((t) => {
            if (!idSet.has(t.id)) return t;
            if (categoryId == null) {
              return { ...t, category_id: null, category_name: null, umbrella_name: null };
            }
            return {
              ...t,
              category_id: categoryId,
              category_name: chosen?.name ?? t.category_name,
              umbrella_name: umbrella?.name ?? null,
            };
          }) ?? current,
      );
    }
    try {
      const { categorizeTransactions } = await import("@/lib/db");
      const next = await categorizeTransactions(ids, categoryId);
      setRows(next);
      const changed = next.filter((t) => before.get(t.id) !== t.category_id).length;
      if (categoryId == null) {
        setNotice(
          changed === 1
            ? "Cleared the category on 1 transaction."
            : `Cleared the category on ${changed} transactions.`,
        );
      } else {
        const name = chosen?.name ?? "that category";
        const countLabel = changed === 1 ? "1 transaction" : `${changed} transactions`;
        setNotice(
          `Categorized ${countLabel}. Each full description was saved under ${name}.`,
        );
      }
      return true;
    } catch (e) {
      setRows(previous);
      setError(e instanceof Error ? e.message : String(e));
      return false;
    } finally {
      setCategorizing(false);
    }
  }

  async function handleAssignSelected() {
    const categoryId = Number(assignCategory);
    if (!Number.isInteger(categoryId) || categoryId <= 0) return;
    const ok = await assignTo([...selected], categoryId);
    if (ok) setSelected(new Set());
  }

  async function handleDateChange(id: number, date: string) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      setRows((current) => (current ? [...current] : current));
      return;
    }
    const current = rows?.find((t) => t.id === id);
    if (!current || current.date === date) return;
    setSavingDateId(id);
    setError("");
    const previousDate = current.date;
    setRows((list) =>
      list
        ? sortTransactions(list.map((t) => (t.id === id ? { ...t, date } : t)))
        : list,
    );
    try {
      const { updateTransactionDate } = await import("@/lib/db");
      const stored = await updateTransactionDate(id, date);
      setRows((list) =>
        list
          ? sortTransactions(list.map((t) => (t.id === id ? { ...t, date: stored } : t)))
          : list,
      );
    } catch (e) {
      setRows((list) =>
        list
          ? sortTransactions(
              list.map((t) => (t.id === id ? { ...t, date: previousDate } : t)),
            )
          : list,
      );
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSavingDateId(null);
    }
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
    <main className={pageShell}>
      <section className="flex flex-col gap-4 rounded-xl border border-zinc-200 bg-white p-4 sm:p-5 dark:border-zinc-800 dark:bg-zinc-900">
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
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:flex lg:flex-wrap lg:items-end">
              <label className="flex min-w-0 flex-col gap-1 text-sm sm:min-w-40">
                <span className="font-medium text-zinc-700 dark:text-zinc-300">Month</span>
                <select
                  value={month}
                  onChange={(e) => writeFilters({ month: e.target.value })}
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
              <label className="flex min-w-0 flex-col gap-1 text-sm sm:min-w-40">
                <span className="font-medium text-zinc-700 dark:text-zinc-300">Category</span>
                <select
                  value={category}
                  onChange={(e) => writeFilters({ category: e.target.value })}
                  className={fieldClass}
                >
                  <option value="">All categories</option>
                  {categoryFilters.map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex min-w-0 flex-col gap-1 text-sm sm:min-w-40">
                <span className="font-medium text-zinc-700 dark:text-zinc-300">Account</span>
                <select
                  value={account}
                  onChange={(e) => writeFilters({ account: e.target.value })}
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
              <div className="flex flex-wrap items-center gap-2">
                <select
                  value={assignCategory}
                  onChange={(e) => setAssignCategory(e.target.value)}
                  disabled={categorizing || categories.length === 0}
                  aria-label="Category for selected transactions"
                  className={fieldClass}
                >
                  <option value="">Choose a category</option>
                  {categoryGroups.map((group) => (
                    <optgroup key={group.id} label={group.name}>
                      {group.items.map((item) => (
                        <option key={item.id} value={item.id}>
                          {item.name}
                        </option>
                      ))}
                    </optgroup>
                  ))}
                </select>
                <button
                  type="button"
                  onClick={() => void handleAssignSelected()}
                  disabled={
                    selected.size === 0 ||
                    !assignCategory ||
                    categorizing ||
                    deleting
                  }
                  className="rounded-md bg-blue-600 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-40"
                >
                  {categorizing
                    ? "Categorizing…"
                    : `Categorize selected${selected.size > 0 ? ` (${selected.size})` : ""}`}
                </button>
                <button
                  type="button"
                  onClick={handleDelete}
                  disabled={selected.size === 0 || deleting || categorizing}
                  className="rounded-md border border-red-300 px-3 py-1.5 text-xs font-medium text-red-700 disabled:opacity-40 dark:border-red-800 dark:text-red-400"
                >
                  {deleting
                    ? "Deleting…"
                    : `Delete selected${selected.size > 0 ? ` (${selected.size})` : ""}`}
                </button>
              </div>
            </div>
            {notice && (
              <p className="text-sm text-zinc-600 dark:text-zinc-400">{notice}</p>
            )}
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
                      <input
                        type="date"
                        value={t.date}
                        onChange={(e) => void handleDateChange(t.id, e.target.value)}
                        disabled={savingDateId === t.id || deleting || categorizing}
                        aria-label={`Date for ${t.description || t.date}`}
                        className={rowDateClass}
                      />
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
                    <td className="px-2 py-1 align-top">
                      <select
                        value={t.category_id ?? ""}
                        onChange={(e) => {
                          const value = e.target.value;
                          void assignTo(
                            [t.id],
                            value ? Number(value) : null,
                          );
                        }}
                        disabled={categorizing || deleting}
                        aria-label={`Category for ${t.description || t.date}`}
                        className={rowSelectClass}
                      >
                        <option value="">Uncategorized</option>
                        {categoryGroups.map((group) => (
                          <optgroup key={group.id} label={group.name}>
                            {group.items.map((item) => (
                              <option key={item.id} value={item.id}>
                                {item.name}
                              </option>
                            ))}
                          </optgroup>
                        ))}
                      </select>
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
