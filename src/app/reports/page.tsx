"use client";

import { Fragment, useEffect, useMemo, useState } from "react";
import type { CategoryRow, Flow, TransactionRow, UmbrellaCategoryRow } from "@/lib/db";

const money = new Intl.NumberFormat("en-SG", {
  style: "currency",
  currency: "SGD",
});

const navButtonClass =
  "rounded-md border border-zinc-300 px-3 py-1.5 text-sm font-medium disabled:opacity-40 dark:border-zinc-700";

function formatMonth(yearMonth: string): string {
  const [year, month] = yearMonth.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, 1)).toLocaleDateString("en-SG", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

function shiftMonth(yearMonth: string, delta: number): string {
  const [year, month] = yearMonth.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1 + delta, 1));
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

function currentMonth(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

/** Credits add; debits subtract. Amounts are stored in cents. */
function signedCents(transaction: TransactionRow): number {
  return transaction.type === "debit" ? -transaction.amount : transaction.amount;
}

function formatSigned(cents: number): string {
  const formatted = money.format(Math.abs(cents) / 100);
  return cents < 0 ? `-${formatted}` : formatted;
}

function amountClass(cents: number): string {
  if (cents < 0) return "text-red-600 dark:text-red-400";
  if (cents > 0) return "text-green-600 dark:text-green-400";
  return "";
}

type CategoryTotal = {
  key: string;
  name: string;
  cents: number;
};

type UmbrellaGroup = {
  key: string;
  name: string;
  cents: number;
  categories: CategoryTotal[];
};

const FLOW_SUMMARY: readonly { flow: Flow; label: string }[] = [
  { flow: "income", label: "Income" },
  { flow: "transfer", label: "Transfer" },
  { flow: "expense", label: "Expense" },
];

export default function ReportsPage() {
  const [transactions, setTransactions] = useState<TransactionRow[] | null>(null);
  const [categories, setCategories] = useState<CategoryRow[] | null>(null);
  const [umbrellas, setUmbrellas] = useState<UmbrellaCategoryRow[] | null>(null);
  const [error, setError] = useState("");
  const [month, setMonth] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { listCategories, listTransactions, listUmbrellaCategories } = await import(
          "@/lib/db"
        );
        const [loadedTransactions, loadedCategories, loadedUmbrellas] = await Promise.all([
          listTransactions(),
          listCategories(),
          listUmbrellaCategories(),
        ]);
        if (!cancelled) {
          setTransactions(loadedTransactions);
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

  const bounds = useMemo(() => {
    if (!transactions || transactions.length === 0) return null;
    let first = transactions[0].date.slice(0, 7);
    let last = first;
    for (const transaction of transactions) {
      const value = transaction.date.slice(0, 7);
      if (value < first) first = value;
      if (value > last) last = value;
    }
    return { first, last };
  }, [transactions]);

  const selected = month ?? bounds?.last ?? currentMonth();
  const canGoBack = bounds != null && selected > bounds.first;
  const canGoForward = bounds != null && selected < bounds.last;

  const report = useMemo(() => {
    const umbrellaById = new Map((umbrellas ?? []).map((row) => [row.id, row]));
    const known = new Map((categories ?? []).map((row) => [row.id, row]));
    const totals = new Map<number, number>();
    const flowTotals: Record<Flow, number> = { income: 0, expense: 0, transfer: 0 };
    let unclassified = 0;

    for (const transaction of transactions ?? []) {
      if (transaction.date.slice(0, 7) !== selected) continue;
      const cents = signedCents(transaction);
      const category =
        transaction.category_id == null ? undefined : known.get(transaction.category_id);
      if (!category) {
        unclassified += cents;
        continue;
      }
      totals.set(category.id, (totals.get(category.id) ?? 0) + cents);
      flowTotals[category.flow] += cents;
    }

    const byUmbrella = new Map<number, CategoryTotal[]>();
    for (const category of categories ?? []) {
      const items = byUmbrella.get(category.umbrella_id) ?? [];
      items.push({
        key: String(category.id),
        name: category.name,
        cents: totals.get(category.id) ?? 0,
      });
      byUmbrella.set(category.umbrella_id, items);
    }

    const groups: UmbrellaGroup[] = [...byUmbrella.entries()].map(([id, items]) => {
      items.sort((a, b) => a.name.localeCompare(b.name));
      return {
        key: String(id),
        name: umbrellaById.get(id)?.name ?? "Ungrouped",
        cents: items.reduce((sum, item) => sum + item.cents, 0),
        categories: items,
      };
    });
    groups.sort((a, b) => a.name.localeCompare(b.name));

    const summary = FLOW_SUMMARY.map((item) => ({
      ...item,
      cents: flowTotals[item.flow],
    }));

    return {
      groups,
      unclassified,
      summary,
      total: summary.reduce((sum, item) => sum + item.cents, 0) + unclassified,
    };
  }, [categories, selected, transactions, umbrellas]);

  const loaded = transactions !== null && categories !== null && umbrellas !== null;

  return (
    <main className="mx-auto flex max-w-6xl flex-col gap-8 px-6 py-12">
      <section className="flex flex-col gap-4 rounded-xl border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
        <div className="flex items-center justify-between gap-3">
          <button
            type="button"
            onClick={() => setMonth(shiftMonth(selected, -1))}
            disabled={!canGoBack}
            className={navButtonClass}
          >
            Previous
          </button>
          <h2 className="text-base font-semibold">{formatMonth(selected)}</h2>
          <button
            type="button"
            onClick={() => setMonth(shiftMonth(selected, 1))}
            disabled={!canGoForward}
            className={navButtonClass}
          >
            Next
          </button>
        </div>

        {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}

        {!loaded && !error && (
          <p className="text-sm text-zinc-600 dark:text-zinc-400">Loading…</p>
        )}

        {loaded && (
          <>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              {report.summary.map((item) => (
                <div
                  key={item.flow}
                  className="rounded-md border border-zinc-200 px-3 py-2 dark:border-zinc-800"
                >
                  <p className="text-xs font-medium uppercase tracking-wide text-zinc-500">
                    {item.label}
                  </p>
                  <p className={`mt-1 text-lg font-semibold ${amountClass(item.cents)}`}>
                    {formatSigned(item.cents)}
                  </p>
                </div>
              ))}
              <div className="rounded-md border border-zinc-200 px-3 py-2 dark:border-zinc-800">
                <p className="text-xs font-medium uppercase tracking-wide text-zinc-500">
                  Unclassified
                </p>
                <p className={`mt-1 text-lg font-semibold ${amountClass(report.unclassified)}`}>
                  {formatSigned(report.unclassified)}
                </p>
              </div>
            </div>

            <div className="flex items-center justify-between rounded-md border border-zinc-200 px-3 py-2 dark:border-zinc-800">
              <p className="text-xs font-medium uppercase tracking-wide text-zinc-500">Total</p>
              <p className={`text-lg font-semibold ${amountClass(report.total)}`}>
                {formatSigned(report.total)}
              </p>
            </div>

            <div className="overflow-x-auto rounded-md border border-zinc-200 dark:border-zinc-800">
              <table className="w-full border-collapse text-sm">
                <thead>
                  <tr className="border-b border-zinc-200 text-left font-medium dark:border-zinc-800">
                    <th className="px-2 py-1">Category</th>
                    <th className="px-2 py-1 text-right">Total</th>
                  </tr>
                </thead>
                <tbody>
                  {report.groups.map((group) => (
                    <Fragment key={group.key}>
                      <tr className="bg-zinc-100 font-semibold dark:bg-zinc-800">
                        <td className="whitespace-nowrap px-2 py-1">{group.name}</td>
                        <td
                          className={`whitespace-nowrap px-2 py-1 text-right ${amountClass(group.cents)}`}
                        >
                          {formatSigned(group.cents)}
                        </td>
                      </tr>
                      {group.categories.map((category) => (
                        <tr key={category.key}>
                          <td className="whitespace-nowrap px-2 py-1 pl-6 text-zinc-700 dark:text-zinc-300">
                            {category.name}
                          </td>
                          <td
                            className={`whitespace-nowrap px-2 py-1 text-right ${amountClass(category.cents)}`}
                          >
                            {formatSigned(category.cents)}
                          </td>
                        </tr>
                      ))}
                    </Fragment>
                  ))}
                  <tr className="border-t border-zinc-200 font-semibold dark:border-zinc-800">
                    <td className="whitespace-nowrap px-2 py-1">Unclassified</td>
                    <td
                      className={`whitespace-nowrap px-2 py-1 text-right ${amountClass(report.unclassified)}`}
                    >
                      {formatSigned(report.unclassified)}
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </>
        )}
      </section>
    </main>
  );
}
