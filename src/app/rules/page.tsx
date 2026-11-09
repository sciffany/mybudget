"use client";

import { useEffect, useMemo, useState, type FormEvent } from "react";
import type {
  CategoryRow,
  RuleRow,
  TransactionType,
  UmbrellaCategoryRow,
} from "@/lib/db";

const money = new Intl.NumberFormat("en-SG", {
  style: "currency",
  currency: "SGD",
});

const TYPE_LABELS: Record<TransactionType, string> = {
  debit: "Debit",
  credit: "Credit",
};

function formatCents(cents: number): string {
  return money.format(cents / 100);
}

function centsToInput(cents: number): string {
  return (cents / 100).toFixed(2);
}

/** Parse a dollar amount into integer cents. Rejects more than two decimal places. */
function dollarsToCents(raw: string, label: string): number {
  const trimmed = raw.trim().replace(/,/g, "");
  if (!trimmed) throw new Error(`Enter a ${label}.`);
  if (!/^\d+(\.\d{1,2})?$/.test(trimmed)) {
    throw new Error(`${label} must be a dollar amount with up to two decimal places.`);
  }
  const [whole, frac = ""] = trimmed.split(".");
  return Number(whole) * 100 + Number(frac.padEnd(2, "0"));
}

function normalizeSubstrings(raw: string): string {
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join("\n");
}

const emptyForm = {
  substrings: "",
  minAmount: "",
  maxAmount: "",
  type: "debit" as TransactionType,
  categoryId: "",
};

export default function RulesPage() {
  const [rows, setRows] = useState<RuleRow[] | null>(null);
  const [categories, setCategories] = useState<CategoryRow[] | null>(null);
  const [umbrellas, setUmbrellas] = useState<UmbrellaCategoryRow[]>([]);
  const [substrings, setSubstrings] = useState(emptyForm.substrings);
  const [minAmount, setMinAmount] = useState(emptyForm.minAmount);
  const [maxAmount, setMaxAmount] = useState(emptyForm.maxAmount);
  const [type, setType] = useState<TransactionType>(emptyForm.type);
  const [categoryId, setCategoryId] = useState(emptyForm.categoryId);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [formError, setFormError] = useState("");
  const [listError, setListError] = useState("");
  const [saving, setSaving] = useState(false);
  const [busyId, setBusyId] = useState<number | null>(null);

  const categoryGroups = useMemo(() => {
    const byUmbrella = new Map<number, CategoryRow[]>();
    for (const category of categories ?? []) {
      const group = byUmbrella.get(category.umbrella_id) ?? [];
      group.push(category);
      byUmbrella.set(category.umbrella_id, group);
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

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { listCategories, listRules, listUmbrellaCategories } = await import(
          "@/lib/db"
        );
        const [rules, loadedCategories, loadedUmbrellas] = await Promise.all([
          listRules(),
          listCategories(),
          listUmbrellaCategories(),
        ]);
        if (!cancelled) {
          setRows(rules);
          setCategories(loadedCategories);
          setUmbrellas(loadedUmbrellas);
        }
      } catch (e) {
        if (!cancelled) setListError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  function resetForm() {
    setSubstrings(emptyForm.substrings);
    setMinAmount(emptyForm.minAmount);
    setMaxAmount(emptyForm.maxAmount);
    setType(emptyForm.type);
    setCategoryId(emptyForm.categoryId);
    setEditingId(null);
  }

  function readForm() {
    const normalized = normalizeSubstrings(substrings);
    if (!normalized) {
      throw new Error("Enter at least one substring, one per line.");
    }
    const min = dollarsToCents(minAmount, "minimum amount");
    const max = dollarsToCents(maxAmount, "maximum amount");
    if (min > max) {
      throw new Error("Minimum amount cannot be greater than the maximum.");
    }
    const chosen = Number(categoryId);
    if (!Number.isInteger(chosen) || chosen <= 0) {
      throw new Error("Choose a category.");
    }
    return {
      substrings: normalized,
      minAmount: min,
      maxAmount: max,
      type,
      categoryId: chosen,
    };
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setFormError("");
    let payload;
    try {
      payload = readForm();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : String(err));
      return;
    }

    setSaving(true);
    try {
      const { insertRule, updateRule } = await import("@/lib/db");
      if (editingId === null) {
        const saved = await insertRule(payload);
        setRows((current) => [...(current ?? []), saved]);
      } else {
        const saved = await updateRule(editingId, payload);
        setRows((current) =>
          (current ?? []).map((row) => (row.id === saved.id ? saved : row)),
        );
      }
      resetForm();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  function startEdit(rule: RuleRow) {
    setEditingId(rule.id);
    setSubstrings(rule.substrings);
    setMinAmount(centsToInput(rule.min_amount));
    setMaxAmount(centsToInput(rule.max_amount));
    setType(rule.type);
    setCategoryId(String(rule.category_id));
    setFormError("");
    setListError("");
  }

  async function handleDelete(rule: RuleRow) {
    const preview = rule.substrings.split("\n")[0];
    if (!window.confirm(`Delete the rule for "${preview}"? This cannot be undone.`)) {
      return;
    }
    setBusyId(rule.id);
    setListError("");
    try {
      const { deleteRule } = await import("@/lib/db");
      await deleteRule(rule.id);
      setRows((current) => current?.filter((row) => row.id !== rule.id) ?? current);
      if (editingId === rule.id) resetForm();
    } catch (err) {
      setListError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyId(null);
    }
  }

  const busy = saving || busyId !== null;

  return (
    <main className="mx-auto flex max-w-6xl flex-col gap-8 px-6 py-12">
      <section className="flex flex-col gap-4 rounded-xl border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-500">
          {editingId === null ? "New rule" : "Edit rule"}
        </h2>
        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium text-zinc-700 dark:text-zinc-300">
              Substrings
            </span>
            <textarea
              value={substrings}
              onChange={(e) => setSubstrings(e.target.value)}
              placeholder={"FAIRPRICE\nNTUC"}
              rows={4}
              disabled={saving}
              className="rounded-md border border-zinc-300 bg-white px-3 py-2 font-mono text-sm dark:border-zinc-700 dark:bg-zinc-950"
            />
            <span className="text-zinc-500">
              One per line. A transaction matches when its description contains
              every line.
            </span>
          </label>
          <label className="flex max-w-sm flex-col gap-1 text-sm">
            <span className="font-medium text-zinc-700 dark:text-zinc-300">
              Category
            </span>
            <select
              value={categoryId}
              onChange={(e) => setCategoryId(e.target.value)}
              disabled={saving || categories?.length === 0}
              className="rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-950"
            >
              <option value="">Choose a category</option>
              {categoryGroups.map((group) => (
                <optgroup key={group.id} label={group.name}>
                  {group.items.map((category) => (
                    <option key={category.id} value={category.id}>
                      {category.name}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
            {categories?.length === 0 && (
              <span className="text-zinc-500">
                Create a category before adding a rule.
              </span>
            )}
          </label>
          <div className="flex flex-wrap items-end gap-3">
            <label className="flex w-40 flex-col gap-1 text-sm">
              <span className="font-medium text-zinc-700 dark:text-zinc-300">
                Minimum
              </span>
              <input
                value={minAmount}
                onChange={(e) => setMinAmount(e.target.value)}
                inputMode="decimal"
                placeholder="0.00"
                disabled={saving}
                className="rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-950"
              />
            </label>
            <label className="flex w-40 flex-col gap-1 text-sm">
              <span className="font-medium text-zinc-700 dark:text-zinc-300">
                Maximum
              </span>
              <input
                value={maxAmount}
                onChange={(e) => setMaxAmount(e.target.value)}
                inputMode="decimal"
                placeholder="50.00"
                disabled={saving}
                className="rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-950"
              />
            </label>
            <label className="flex w-36 flex-col gap-1 text-sm">
              <span className="font-medium text-zinc-700 dark:text-zinc-300">
                Type
              </span>
              <select
                value={type}
                onChange={(e) => setType(e.target.value as TransactionType)}
                disabled={saving}
                className="rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-950"
              >
                <option value="debit">Debit</option>
                <option value="credit">Credit</option>
              </select>
            </label>
            <button
              type="submit"
              disabled={saving || !categories?.length}
              className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-40"
            >
              {saving ? "Saving..." : editingId === null ? "Create rule" : "Save rule"}
            </button>
            {editingId !== null && (
              <button
                type="button"
                onClick={resetForm}
                disabled={saving}
                className="rounded-md border border-zinc-300 px-4 py-2 text-sm font-medium disabled:opacity-40 dark:border-zinc-700"
              >
                Cancel
              </button>
            )}
          </div>
        </form>
        {formError && (
          <p className="text-sm text-red-600 dark:text-red-400">{formError}</p>
        )}
      </section>

      <section className="flex flex-col gap-4 rounded-xl border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-500">
          Rules{rows ? ` (${rows.length})` : ""}
        </h2>

        {listError && (
          <p className="text-sm text-red-600 dark:text-red-400">{listError}</p>
        )}

        {rows === null && !listError && (
          <p className="text-sm text-zinc-600 dark:text-zinc-400">Loading…</p>
        )}

        {rows && rows.length === 0 && (
          <p className="text-sm text-zinc-600 dark:text-zinc-400">
            No rules yet. Create one above.
          </p>
        )}

        {rows && rows.length > 0 && (
          <ul className="divide-y divide-zinc-200 dark:divide-zinc-800">
            {rows.map((rule) => (
              <li key={rule.id} className="flex items-start justify-between gap-4 py-3 text-sm">
                <div className="min-w-0 flex-1">
                  <p className="font-medium">{rule.category_name}</p>
                  <p className="mt-1 whitespace-pre-wrap font-mono">{rule.substrings}</p>
                  <p className="mt-1 text-zinc-500">
                    {formatCents(rule.min_amount)} – {formatCents(rule.max_amount)}
                    {" · "}
                    {TYPE_LABELS[rule.type]}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => startEdit(rule)}
                  disabled={busy}
                  className="rounded-md border border-zinc-300 px-3 py-1.5 text-xs font-medium disabled:opacity-40 dark:border-zinc-700"
                >
                  Edit
                </button>
                <button
                  type="button"
                  onClick={() => handleDelete(rule)}
                  disabled={busy}
                  className="rounded-md border border-red-300 px-3 py-1.5 text-xs font-medium text-red-700 disabled:opacity-40 dark:border-red-800 dark:text-red-400"
                >
                  {busyId === rule.id ? "Deleting..." : "Delete"}
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
