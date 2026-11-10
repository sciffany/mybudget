"use client";

import { useEffect, useMemo, useState, type FormEvent } from "react";
import {
  FLOW_LABELS,
  FLOWS,
  type CategoryRow,
  type CategoryUsage,
  type Flow,
  type UmbrellaCategoryRow,
  type UmbrellaUsage,
} from "@/lib/db";

const fieldClass =
  "rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-950";
const buttonClass =
  "rounded-md border border-zinc-300 px-3 py-1.5 text-xs font-medium disabled:opacity-40 dark:border-zinc-700";
const deleteClass =
  "rounded-md border border-red-300 px-3 py-1.5 text-xs font-medium text-red-700 disabled:opacity-40 dark:border-red-800 dark:text-red-400";
const saveClass =
  "rounded-md bg-blue-600 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-40";

function countLabel(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

function categoryDeleteMessage(category: CategoryRow, usage: CategoryUsage): string {
  const transactions =
    usage.transactions === 0
      ? "No transactions use it."
      : `${countLabel(usage.transactions, "transaction")} will stay, but will no longer use this category.`;
  const rules =
    usage.rules === 0
      ? ""
      : ` ${countLabel(usage.rules, "rule")} that ${usage.rules === 1 ? "assigns" : "assign"} it will be deleted.`;
  return `Delete "${category.name}"? ${transactions}${rules} This cannot be undone.`;
}

function umbrellaDeleteMessage(umbrella: UmbrellaCategoryRow, usage: UmbrellaUsage): string {
  const categories =
    usage.categories === 0
      ? "It has no categories."
      : `${countLabel(usage.categories, "category", "categories")} under it will be deleted.`;
  const transactions =
    usage.transactions === 0
      ? ""
      : ` ${countLabel(usage.transactions, "transaction")} will stay, but will no longer use those categories.`;
  const rules =
    usage.rules === 0
      ? ""
      : ` ${countLabel(usage.rules, "rule")} that ${usage.rules === 1 ? "assigns" : "assign"} them will be deleted.`;
  return `Delete "${umbrella.name}"? ${categories}${transactions}${rules} This cannot be undone.`;
}

export default function CategoriesPage() {
  const [umbrellas, setUmbrellas] = useState<UmbrellaCategoryRow[] | null>(null);
  const [categories, setCategories] = useState<CategoryRow[] | null>(null);
  const [listError, setListError] = useState("");

  const [umbrellaName, setUmbrellaName] = useState("");
  const [umbrellaError, setUmbrellaError] = useState("");
  const [savingUmbrella, setSavingUmbrella] = useState(false);
  const [editingUmbrellaId, setEditingUmbrellaId] = useState<number | null>(null);
  const [editUmbrellaName, setEditUmbrellaName] = useState("");

  const [categoryName, setCategoryName] = useState("");
  const [categoryFlow, setCategoryFlow] = useState<Flow>("expense");
  const [categoryUmbrellaId, setCategoryUmbrellaId] = useState("");
  const [categoryError, setCategoryError] = useState("");
  const [savingCategory, setSavingCategory] = useState(false);
  const [editingCategoryId, setEditingCategoryId] = useState<number | null>(null);
  const [editCategoryName, setEditCategoryName] = useState("");
  const [editCategoryFlow, setEditCategoryFlow] = useState<Flow>("expense");
  const [editCategoryUmbrellaId, setEditCategoryUmbrellaId] = useState("");

  const [busyKey, setBusyKey] = useState<string | null>(null);

  const groups = useMemo(() => {
    const byUmbrella = new Map<number, CategoryRow[]>();
    for (const category of categories ?? []) {
      const group = byUmbrella.get(category.umbrella_id) ?? [];
      group.push(category);
      byUmbrella.set(category.umbrella_id, group);
    }
    return (umbrellas ?? []).map((umbrella) => ({
      umbrella,
      categories: byUmbrella.get(umbrella.id) ?? [],
    }));
  }, [categories, umbrellas]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { listCategories, listUmbrellaCategories } = await import("@/lib/db");
        const [loadedCategories, loadedUmbrellas] = await Promise.all([
          listCategories(),
          listUmbrellaCategories(),
        ]);
        if (!cancelled) {
          setCategories(loadedCategories);
          setUmbrellas(loadedUmbrellas);
          setCategoryUmbrellaId((current) => {
            if (loadedUmbrellas.some((row) => String(row.id) === current)) return current;
            return loadedUmbrellas[0] ? String(loadedUmbrellas[0].id) : "";
          });
        }
      } catch (e) {
        if (!cancelled) setListError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  function sortUmbrellas(rows: UmbrellaCategoryRow[]) {
    return [...rows].sort((a, b) => a.name.localeCompare(b.name));
  }

  function sortCategories(rows: CategoryRow[]) {
    return [...rows].sort((a, b) => a.name.localeCompare(b.name));
  }

  function cancelUmbrellaEdit() {
    setEditingUmbrellaId(null);
    setEditUmbrellaName("");
  }

  function cancelCategoryEdit() {
    setEditingCategoryId(null);
    setEditCategoryName("");
    setEditCategoryFlow("expense");
    setEditCategoryUmbrellaId("");
  }

  async function handleCreateUmbrella(e: FormEvent) {
    e.preventDefault();
    const trimmed = umbrellaName.trim();
    if (!trimmed) {
      setUmbrellaError("Enter a name for the umbrella category.");
      return;
    }
    setSavingUmbrella(true);
    setUmbrellaError("");
    try {
      const { insertUmbrellaCategory } = await import("@/lib/db");
      const id = await insertUmbrellaCategory({ name: trimmed });
      setUmbrellas((current) => sortUmbrellas([...(current ?? []), { id, name: trimmed }]));
      setCategoryUmbrellaId((current) => current || String(id));
      setUmbrellaName("");
    } catch (err) {
      setUmbrellaError(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingUmbrella(false);
    }
  }

  function startUmbrellaEdit(umbrella: UmbrellaCategoryRow) {
    cancelCategoryEdit();
    setEditingUmbrellaId(umbrella.id);
    setEditUmbrellaName(umbrella.name);
    setListError("");
  }

  async function handleUpdateUmbrella(e: FormEvent, umbrella: UmbrellaCategoryRow) {
    e.preventDefault();
    const trimmed = editUmbrellaName.trim();
    if (!trimmed) {
      setListError("Enter a name for the umbrella category.");
      return;
    }
    if (trimmed === umbrella.name) {
      cancelUmbrellaEdit();
      return;
    }
    const key = `umbrella:${umbrella.id}`;
    setBusyKey(key);
    setListError("");
    try {
      const { updateUmbrellaCategory } = await import("@/lib/db");
      const stored = await updateUmbrellaCategory(umbrella.id, { name: trimmed });
      setUmbrellas((current) =>
        sortUmbrellas(
          (current ?? []).map((row) => (row.id === umbrella.id ? stored : row)),
        ),
      );
      cancelUmbrellaEdit();
    } catch (err) {
      setListError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyKey(null);
    }
  }

  async function handleDeleteUmbrella(umbrella: UmbrellaCategoryRow) {
    setListError("");
    const key = `umbrella:${umbrella.id}`;
    try {
      const { countUmbrellaUsage, deleteUmbrellaCategory } = await import("@/lib/db");
      const usage = await countUmbrellaUsage(umbrella.id);
      if (!window.confirm(umbrellaDeleteMessage(umbrella, usage))) return;
      setBusyKey(key);
      await deleteUmbrellaCategory(umbrella.id);
      const remaining = (umbrellas ?? []).filter((row) => row.id !== umbrella.id);
      setUmbrellas(remaining);
      setCategories(
        (current) => current?.filter((row) => row.umbrella_id !== umbrella.id) ?? current,
      );
      setCategoryUmbrellaId((current) =>
        current === String(umbrella.id)
          ? remaining[0]
            ? String(remaining[0].id)
            : ""
          : current,
      );
      if (editingUmbrellaId === umbrella.id) cancelUmbrellaEdit();
      if (
        categories?.some(
          (row) => row.umbrella_id === umbrella.id && row.id === editingCategoryId,
        )
      ) {
        cancelCategoryEdit();
      }
    } catch (err) {
      setListError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyKey(null);
    }
  }

  async function handleCreateCategory(e: FormEvent) {
    e.preventDefault();
    const trimmed = categoryName.trim();
    const umbrellaId = Number(categoryUmbrellaId);
    if (!trimmed) {
      setCategoryError("Enter a name for the category.");
      return;
    }
    if (!Number.isInteger(umbrellaId) || umbrellaId <= 0) {
      setCategoryError("Choose an umbrella category.");
      return;
    }
    setSavingCategory(true);
    setCategoryError("");
    try {
      const { insertCategory } = await import("@/lib/db");
      const id = await insertCategory({
        name: trimmed,
        flow: categoryFlow,
        umbrellaId,
      });
      setCategories((current) =>
        sortCategories([
          ...(current ?? []),
          { id, name: trimmed, flow: categoryFlow, umbrella_id: umbrellaId },
        ]),
      );
      setCategoryName("");
      setCategoryFlow("expense");
    } catch (err) {
      setCategoryError(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingCategory(false);
    }
  }

  function startCategoryEdit(category: CategoryRow) {
    cancelUmbrellaEdit();
    setEditingCategoryId(category.id);
    setEditCategoryName(category.name);
    setEditCategoryFlow(category.flow);
    setEditCategoryUmbrellaId(String(category.umbrella_id));
    setListError("");
  }

  async function handleUpdateCategory(e: FormEvent, category: CategoryRow) {
    e.preventDefault();
    const trimmed = editCategoryName.trim();
    const umbrellaId = Number(editCategoryUmbrellaId);
    if (!trimmed) {
      setListError("Enter a name for the category.");
      return;
    }
    if (!Number.isInteger(umbrellaId) || umbrellaId <= 0) {
      setListError("Choose an umbrella category.");
      return;
    }
    if (
      trimmed === category.name &&
      editCategoryFlow === category.flow &&
      umbrellaId === category.umbrella_id
    ) {
      cancelCategoryEdit();
      return;
    }
    const key = `category:${category.id}`;
    setBusyKey(key);
    setListError("");
    try {
      const { updateCategory } = await import("@/lib/db");
      const stored = await updateCategory(category.id, {
        name: trimmed,
        flow: editCategoryFlow,
        umbrellaId,
      });
      setCategories((current) =>
        sortCategories(
          (current ?? []).map((row) => (row.id === category.id ? stored : row)),
        ),
      );
      cancelCategoryEdit();
    } catch (err) {
      setListError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyKey(null);
    }
  }

  async function handleDeleteCategory(category: CategoryRow) {
    setListError("");
    const key = `category:${category.id}`;
    try {
      const { countCategoryUsage, deleteCategory } = await import("@/lib/db");
      const usage = await countCategoryUsage(category.id);
      if (!window.confirm(categoryDeleteMessage(category, usage))) return;
      setBusyKey(key);
      await deleteCategory(category.id);
      setCategories((current) => current?.filter((row) => row.id !== category.id) ?? current);
      if (editingCategoryId === category.id) cancelCategoryEdit();
    } catch (err) {
      setListError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyKey(null);
    }
  }

  const busy = savingUmbrella || savingCategory || busyKey !== null;
  const loading = umbrellas === null || categories === null;

  return (
    <main className="mx-auto flex max-w-6xl flex-col gap-6 px-4 py-6 sm:gap-8 sm:px-6 sm:py-10">
      <section className="flex flex-col gap-4 rounded-xl border border-zinc-200 bg-white p-4 sm:p-5 dark:border-zinc-800 dark:bg-zinc-900">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-500">
          New umbrella category
        </h2>
        <form onSubmit={handleCreateUmbrella} className="flex flex-wrap items-end gap-3">
          <label className="flex min-w-48 flex-1 flex-col gap-1 text-sm">
            <span className="font-medium text-zinc-700 dark:text-zinc-300">Name</span>
            <input
              value={umbrellaName}
              onChange={(e) => setUmbrellaName(e.target.value)}
              placeholder="Daily Expenses"
              disabled={savingUmbrella}
              className={fieldClass}
            />
          </label>
          <button
            type="submit"
            disabled={savingUmbrella}
            className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-40"
          >
            {savingUmbrella ? "Saving..." : "Create umbrella"}
          </button>
        </form>
        {umbrellaError && (
          <p className="text-sm text-red-600 dark:text-red-400">{umbrellaError}</p>
        )}
      </section>

      <section className="flex flex-col gap-4 rounded-xl border border-zinc-200 bg-white p-4 sm:p-5 dark:border-zinc-800 dark:bg-zinc-900">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-500">
          New category
        </h2>
        <form onSubmit={handleCreateCategory} className="flex flex-wrap items-end gap-3">
          <label className="flex min-w-48 flex-1 flex-col gap-1 text-sm">
            <span className="font-medium text-zinc-700 dark:text-zinc-300">Name</span>
            <input
              value={categoryName}
              onChange={(e) => setCategoryName(e.target.value)}
              placeholder="Food"
              disabled={savingCategory || !umbrellas?.length}
              className={fieldClass}
            />
          </label>
          <label className="flex w-full flex-col gap-1 text-sm sm:w-40">
            <span className="font-medium text-zinc-700 dark:text-zinc-300">Flow</span>
            <select
              value={categoryFlow}
              onChange={(e) => setCategoryFlow(e.target.value as Flow)}
              disabled={savingCategory || !umbrellas?.length}
              className={fieldClass}
            >
              {FLOWS.map((flow) => (
                <option key={flow} value={flow}>
                  {FLOW_LABELS[flow]}
                </option>
              ))}
            </select>
          </label>
          <label className="flex min-w-48 flex-1 flex-col gap-1 text-sm">
            <span className="font-medium text-zinc-700 dark:text-zinc-300">
              Umbrella
            </span>
            <select
              value={categoryUmbrellaId}
              onChange={(e) => setCategoryUmbrellaId(e.target.value)}
              disabled={savingCategory || !umbrellas?.length}
              className={fieldClass}
            >
              {(umbrellas ?? []).map((umbrella) => (
                <option key={umbrella.id} value={umbrella.id}>
                  {umbrella.name}
                </option>
              ))}
            </select>
          </label>
          <button
            type="submit"
            disabled={savingCategory || !umbrellas?.length}
            className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-40"
          >
            {savingCategory ? "Saving..." : "Create category"}
          </button>
        </form>
        {umbrellas && umbrellas.length === 0 && (
          <p className="text-sm text-zinc-600 dark:text-zinc-400">
            Create an umbrella category before adding a category.
          </p>
        )}
        {categoryError && (
          <p className="text-sm text-red-600 dark:text-red-400">{categoryError}</p>
        )}
      </section>

      <section className="flex flex-col gap-4">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-500">
          Umbrella categories{umbrellas ? ` (${umbrellas.length})` : ""}
        </h2>

        {listError && (
          <p className="text-sm text-red-600 dark:text-red-400">{listError}</p>
        )}

        {loading && !listError && (
          <p className="text-sm text-zinc-600 dark:text-zinc-400">Loading…</p>
        )}

        {umbrellas && umbrellas.length === 0 && (
          <section className="rounded-xl border border-zinc-200 bg-white p-4 sm:p-5 dark:border-zinc-800 dark:bg-zinc-900">
            <p className="text-sm text-zinc-600 dark:text-zinc-400">
              No umbrella categories yet. Create one above.
            </p>
          </section>
        )}

        {groups.map(({ umbrella, categories: items }) => {
          const umbrellaKey = `umbrella:${umbrella.id}`;
          const umbrellaBusy = busyKey === umbrellaKey;

          return (
            <section
              key={umbrella.id}
              className="flex flex-col gap-3 rounded-xl border border-zinc-200 bg-white p-4 sm:p-5 dark:border-zinc-800 dark:bg-zinc-900"
            >
              {editingUmbrellaId === umbrella.id ? (
                <form
                  onSubmit={(e) => handleUpdateUmbrella(e, umbrella)}
                  className="flex flex-wrap items-center gap-2"
                >
                  <input
                    value={editUmbrellaName}
                    onChange={(e) => setEditUmbrellaName(e.target.value)}
                    disabled={umbrellaBusy}
                    aria-label={`Name for ${umbrella.name}`}
                    className={`${fieldClass} min-w-40 flex-1 py-1.5`}
                  />
                  <button type="submit" disabled={umbrellaBusy} className={saveClass}>
                    {umbrellaBusy ? "Saving..." : "Save"}
                  </button>
                  <button
                    type="button"
                    onClick={cancelUmbrellaEdit}
                    disabled={umbrellaBusy}
                    className={buttonClass}
                  >
                    Cancel
                  </button>
                </form>
              ) : (
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <h3 className="text-base font-semibold">{umbrella.name}</h3>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => startUmbrellaEdit(umbrella)}
                      disabled={busy}
                      className={buttonClass}
                    >
                      Rename
                    </button>
                    <button
                      type="button"
                      onClick={() => handleDeleteUmbrella(umbrella)}
                      disabled={busy}
                      className={deleteClass}
                    >
                      {umbrellaBusy ? "Deleting..." : "Delete"}
                    </button>
                  </div>
                </div>
              )}

              {items.length === 0 ? (
                <p className="text-sm text-zinc-600 dark:text-zinc-400">
                  No categories under this umbrella yet.
                </p>
              ) : (
                <ul className="divide-y divide-zinc-200 dark:divide-zinc-800">
                  {items.map((category) => {
                    const categoryKey = `category:${category.id}`;
                    const categoryBusy = busyKey === categoryKey;

                    if (editingCategoryId === category.id) {
                      return (
                        <li key={category.id} className="py-3">
                          <form
                            onSubmit={(e) => handleUpdateCategory(e, category)}
                            className="flex flex-wrap items-center gap-2"
                          >
                            <input
                              value={editCategoryName}
                              onChange={(e) => setEditCategoryName(e.target.value)}
                              disabled={categoryBusy}
                              aria-label={`Name for ${category.name}`}
                              className={`${fieldClass} min-w-40 flex-1 py-1.5`}
                            />
                            <select
                              value={editCategoryFlow}
                              onChange={(e) => setEditCategoryFlow(e.target.value as Flow)}
                              disabled={categoryBusy}
                              aria-label={`Flow for ${category.name}`}
                              className={`${fieldClass} w-36 py-1.5`}
                            >
                              {FLOWS.map((flow) => (
                                <option key={flow} value={flow}>
                                  {FLOW_LABELS[flow]}
                                </option>
                              ))}
                            </select>
                            <select
                              value={editCategoryUmbrellaId}
                              onChange={(e) => setEditCategoryUmbrellaId(e.target.value)}
                              disabled={categoryBusy}
                              aria-label={`Umbrella for ${category.name}`}
                              className={`${fieldClass} min-w-40 py-1.5`}
                            >
                              {(umbrellas ?? []).map((option) => (
                                <option key={option.id} value={option.id}>
                                  {option.name}
                                </option>
                              ))}
                            </select>
                            <button type="submit" disabled={categoryBusy} className={saveClass}>
                              {categoryBusy ? "Saving..." : "Save"}
                            </button>
                            <button
                              type="button"
                              onClick={cancelCategoryEdit}
                              disabled={categoryBusy}
                              className={buttonClass}
                            >
                              Cancel
                            </button>
                          </form>
                        </li>
                      );
                    }

                    return (
                      <li
                        key={category.id}
                        className="flex flex-wrap items-center justify-between gap-3 py-3 text-sm"
                      >
                        <span className="min-w-0 flex-1 font-medium">{category.name}</span>
                        <span className="text-zinc-500">{FLOW_LABELS[category.flow]}</span>
                        <button
                          type="button"
                          onClick={() => startCategoryEdit(category)}
                          disabled={busy}
                          className={buttonClass}
                        >
                          Edit
                        </button>
                        <button
                          type="button"
                          onClick={() => handleDeleteCategory(category)}
                          disabled={busy}
                          className={deleteClass}
                        >
                          {categoryBusy ? "Deleting..." : "Delete"}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>
          );
        })}
      </section>
    </main>
  );
}
