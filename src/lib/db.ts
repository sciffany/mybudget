// Browser-only persistent storage for MyBudget, built on SQLite compiled to
// WebAssembly (`@sqlite.org/sqlite-wasm`).
//
// We use the OPFS "SAHPool" VFS instead of the plain `OpfsDb`/worker setup.
// SAHPool does NOT require the cross-origin isolation headers (COOP/COEP) that
// the default worker-backed OPFS db needs — which matters because this app
// ships as a fully static export (`output: "export"`) with no server to set
// those headers. Data is persisted in the browser's Origin Private File System
// and survives reloads.
//
// IMPORTANT: SAHPool relies on `FileSystemFileHandle.createSyncAccessHandle()`,
// which the spec marks `[Exposed=DedicatedWorker]` — it simply does not exist on
// the window/main thread in any browser. So the SQLite engine itself has to live
// inside a dedicated Web Worker; calling `installOpfsSAHPoolVfs()` on the main
// thread always fails with "Missing required OPFS APIs." This module therefore
// spins up a worker that owns the database and exposes a small async RPC to it.
// (Avoiding COOP/COEP and needing a worker are independent facts: SAHPool needs
// the worker for the sync access handle, not for cross-origin isolation.)
//
// Everything here runs client-side; the database bytes never leave the browser.

// Keep this version in lockstep with the installed `@sqlite.org/sqlite-wasm`
// dependency. We load the self-contained CDN build inside the worker instead of
// bundling the npm package, whose `index.mjs` statically pulls in a
// `new Worker(new URL(<dynamic>, import.meta.url))` that Turbopack/webpack
// cannot resolve ("Module not found"). This mirrors how `statements/pdf.ts`
// loads its worker.
const SQLITE_WASM_VERSION = "3.54.1-build1";
const SQLITE_WASM_URL = `https://cdn.jsdelivr.net/npm/@sqlite.org/sqlite-wasm@${SQLITE_WASM_VERSION}/dist/index.mjs`;

// Path of the database file inside the SAHPool VFS. Must be absolute.
const DB_PATH = "/budget.sqlite3";
// Dedicated OPFS directory so this app's storage can't collide with anything
// else served from the same origin.
const VFS_DIR = ".mybudget-sqlite";

/**
 * Categories created on every startup when they are missing. Flow follows the
 * umbrella: spending and planning are expenses, Transfer is a transfer, and
 * Income is income. Existing rows with the same name are left alone.
 */
const PRESET_CATEGORY_GROUPS: readonly {
  umbrella: string;
  flow: Flow;
  categories: readonly string[];
}[] = [
  {
    umbrella: "Daily Expenses",
    flow: "expense",
    categories: ["Food", "Transportation", "Housing", "Utility"],
  },
  {
    umbrella: "Special Expenses",
    flow: "expense",
    categories: [
      "Electronics",
      "Clothing",
      "Donation",
      "Subscription",
      "Software Service",
      "Shopping",
      "Travel",
      "Enrichment",
    ],
  },
  {
    umbrella: "Transfer",
    flow: "transfer",
    categories: ["Transfer"],
  },
  {
    umbrella: "Income",
    flow: "income",
    categories: ["Salary", "Interest"],
  },
  {
    umbrella: "Planning",
    flow: "expense",
    categories: ["Investment", "Insurance"],
  },
];

/**
 * Rules created on startup when that preset is missing. A transaction matches
 * when its description contains any substring (ignoring letter case), the
 * amount falls in the range, and the direction matches. Income categories are
 * credits. Transfer has one rule per direction. The rest are debits. The range
 * covers any amount. Each preset has its own key, so two rules for the same
 * category stay separate. Substrings from this list that are missing on an
 * existing preset rule are appended, unless that substring already belongs to
 * another category. Other edits stay in place. A deleted preset is created
 * again.
 */
const PRESET_RULE_MIN_CENTS = 0;
const PRESET_RULE_MAX_CENTS = 99_999_999_99;
const PRESET_RULES: readonly {
  key: string;
  umbrella: string;
  category: string;
  type: TransactionType;
  substrings: readonly string[];
}[] = [
  {
    key: "transfer-debit",
    umbrella: "Transfer",
    category: "Transfer",
    type: "debit",
    substrings: ["Funds Transfer TOP-UP TO PAYLAH!"],
  },
  {
    key: "transfer-credit",
    umbrella: "Transfer",
    category: "Transfer",
    type: "credit",
    substrings: ["TOP UP WALLET FROM MY ACCOUNT REF NO"],
  },
  {
    key: "transportation",
    umbrella: "Daily Expenses",
    category: "Transportation",
    type: "debit",
    substrings: ["BUS/MRT", "Grab", "Taxi", "Bus", "Uber"],
  },
  {
    key: "insurance",
    umbrella: "Planning",
    category: "Insurance",
    type: "debit",
    substrings: ["Insurance", "Etiqa"],
  },
  {
    key: "investment",
    umbrella: "Planning",
    category: "Investment",
    type: "debit",
    substrings: ["Investment", "iFAST"],
  },
  {
    key: "interest",
    umbrella: "Income",
    category: "Interest",
    type: "credit",
    substrings: ["Interest"],
  },
  {
    key: "salary",
    umbrella: "Income",
    category: "Salary",
    type: "credit",
    substrings: ["Sala"],
  },
  {
    key: "shopping",
    umbrella: "Special Expenses",
    category: "Shopping",
    type: "debit",
    substrings: ["Shopee"],
  },
  {
    key: "food",
    umbrella: "Daily Expenses",
    category: "Food",
    type: "debit",
    substrings: [
      "Mala",
      "Ding Ji",
      "Shun Heng",
      "Subway",
      "Mcdonald's",
      "Eleven",
      "Roti",
      "Food",
      "Shun Feng",
      "Tau Foo",
      "Chendol",
      "Bread",
      "Pasta",
      "Donut",
      "Cheers",
      "Ntuc",
      "Hockhua",
      "Yong Tau",
      "Jing Fish",
      "KFC",
      "Tempura",
      "Coffee",
      "Hoe Peng",
      "Bakery",
      "Pizza",
      "Wok",
      "Saap saap",
      "Sanook",
      "Chindamani",
      "Pu tien",
      "Toast",
    ],
  },
  {
    key: "software-service",
    umbrella: "Special Expenses",
    category: "Software Service",
    type: "debit",
    substrings: [
      "Google",
      "Vercel",
      "Heroku",
      "AWS",
      "Openai",
      "ChatGPT",
      "Wix.com",
    ],
  },
  {
    key: "housing",
    umbrella: "Daily Expenses",
    category: "Housing",
    type: "debit",
    substrings: ["Rent", "Mortgage"],
  },
  {
    key: "utility",
    umbrella: "Daily Expenses",
    category: "Utility",
    type: "debit",
    substrings: ["Giga", "Singtel", "Starhub"],
  },
  {
    key: "enrichment",
    umbrella: "Special Expenses",
    category: "Enrichment",
    type: "debit",
    substrings: ["Italki", "Duolingo", "Sport"],
  },
  {
    key: "travel",
    umbrella: "Special Expenses",
    category: "Travel",
    type: "debit",
    substrings: ["Klook", "Trip.com", "Airbnb", "Agoda", "Booking.com", "KRW"],
  },
];

/** A saved statement/document as stored in the `documents` table. */
export interface DocumentRow {
  id: number;
  filename: string;
  page_count: number;
  text: string;
  created_at: string;
}

/** Payload accepted by {@link insertDocument}. */
export interface NewDocument {
  filename: string;
  pageCount: number;
  text: string;
}

// ---------------------------------------------------------------------------
// Budget domain types
// ---------------------------------------------------------------------------

/** Debit = money out of the account, credit = money in. */
export type TransactionType = "debit" | "credit";
/** Semantic nature of a category: money in, money out, or a move between accounts. */
export type Flow = "income" | "expense" | "transfer";
/** Institution/product an account belongs to. */
export type AccountType =
  | "dbs"
  | "ocbc"
  | "uobCredit"
  | "paylah"
  | "ocbcCredit";

/** Every account type the `accounts.type` check constraint accepts. */
export const ACCOUNT_TYPES: readonly AccountType[] = [
  "dbs",
  "ocbc",
  "uobCredit",
  "paylah",
  "ocbcCredit",
];

export const ACCOUNT_TYPE_LABELS: Record<AccountType, string> = {
  dbs: "DBS",
  ocbc: "OCBC",
  uobCredit: "UOB Credit",
  paylah: "PayLah",
  ocbcCredit: "OCBC Credit",
};

/**
 * Accounts created on every startup when that name is missing. Existing rows
 * with the same name are left alone. A renamed or deleted preset is created
 * again under its original name.
 */
const PRESET_ACCOUNTS: readonly { name: string; type: AccountType }[] =
  ACCOUNT_TYPES.map((type) => ({
    name: ACCOUNT_TYPE_LABELS[type],
    type,
  }));

/** A grouping that categories belong to. Transactions are not assigned here directly. */
export interface UmbrellaCategoryRow {
  id: number;
  name: string;
}

/** Rows that disappear or lose their category when an umbrella category is deleted. */
export interface UmbrellaUsage {
  categories: number;
  transactions: number;
  rules: number;
}

/** Every flow the `categories.flow` check constraint accepts. */
export const FLOWS: readonly Flow[] = ["income", "expense", "transfer"];

export const FLOW_LABELS: Record<Flow, string> = {
  income: "Income",
  expense: "Expense",
  transfer: "Transfer",
};

/** A category assigned to transactions. Each one belongs to one umbrella category. */
export interface CategoryRow {
  id: number;
  name: string;
  flow: Flow;
  umbrella_id: number;
}

/** Rows that lose this category, or are deleted with it. */
export interface CategoryUsage {
  transactions: number;
  rules: number;
}

export interface AccountRow {
  id: number;
  name: string;
  type: AccountType;
}

/** A saved PDF statement import. `file_hash` is the SHA-256 of the file bytes. */
export interface ImportRow {
  id: number;
  filename: string;
  file_hash: string;
  page_count: number;
  account_type: AccountType | null;
  created_at: string;
}

export interface TransactionRow {
  id: number;
  /** ISO date, `YYYY-MM-DD`. */
  date: string;
  /** Amount in cents (always non-negative; direction is in `type`). */
  amount: number;
  type: TransactionType;
  description: string;
  category_id: number | null;
  account_id: number | null;
  /** The statement import these rows came from. */
  import_id: number;
  created_at: string;
  /** Assigned category, when one is set. */
  category_name: string | null;
  /** Umbrella category of the assigned category, when one is set. */
  umbrella_name: string | null;
  /** Account this transaction belongs to, when one is set. */
  account_name: string | null;
}

export interface NewUmbrellaCategory {
  name: string;
}
export interface NewCategory {
  name: string;
  flow: Flow;
  umbrellaId: number;
}
export interface NewAccount {
  name: string;
  type: AccountType;
}
export interface NewTransaction {
  date: string;
  amount: number;
  type: TransactionType;
  description?: string;
  categoryId?: number | null;
  accountId?: number | null;
  importId: number;
}

/** One statement PDF plus the transactions parsed out of it. */
export interface NewImport {
  filename: string;
  /** SHA-256 hex of the PDF bytes. Unique, so the same file can't be imported twice. */
  fileHash: string;
  pageCount: number;
  accountType: AccountType;
  transactions: Omit<NewTransaction, "importId">[];
}

/**
 * A rule assigns one category to transactions that match it: any substring
 * must appear in the description, the amount must fall in the inclusive range,
 * and the direction must match. When several rules match, the longest
 * substring wins.
 */
export interface RuleRow {
  id: number;
  /** Newline-separated substrings. Any one may appear in the description. */
  substrings: string;
  /** Inclusive lower bound, in cents. */
  min_amount: number;
  /** Inclusive upper bound, in cents. */
  max_amount: number;
  type: TransactionType;
  /** Category this rule assigns. */
  category_id: number;
  /** Name of {@link category_id}. */
  category_name: string;
}

export interface NewRule {
  /** Newline-separated substrings, before or after trimming blank lines. */
  substrings: string;
  /** Inclusive lower bound, in cents. */
  minAmount: number;
  /** Inclusive upper bound, in cents. */
  maxAmount: number;
  type: TransactionType;
  /** Category the rule assigns when a transaction matches. */
  categoryId: number;
}

// ---------------------------------------------------------------------------
// Worker source
// ---------------------------------------------------------------------------
// This runs inside a dedicated module Worker, where `createSyncAccessHandle` is
// available. It owns the single SQLite connection and answers RPC messages of
// the shape `{ id, method, args }`, replying with `{ id, result }` or
// `{ id, error }`. We build it from a Blob so there's no separate worker file
// for the bundler to choke on, and `import.meta.url` games to play.
const WORKER_SOURCE = /* js */ `
import sqlite3InitModule from ${JSON.stringify(SQLITE_WASM_URL)};

const DB_PATH = ${JSON.stringify(DB_PATH)};
const VFS_DIR = ${JSON.stringify(VFS_DIR)};
const PRESET_CATEGORY_GROUPS = ${JSON.stringify(PRESET_CATEGORY_GROUPS)};
const PRESET_ACCOUNTS = ${JSON.stringify(PRESET_ACCOUNTS)};
const PRESET_RULES = ${JSON.stringify(PRESET_RULES)};
const PRESET_RULE_MIN_CENTS = ${PRESET_RULE_MIN_CENTS};
const PRESET_RULE_MAX_CENTS = ${PRESET_RULE_MAX_CENTS};

let sqlite3, pool, db;

/** Row id of the most recent INSERT on the shared connection. */
function lastId() {
  const [[id]] = db.exec({
    sql: "SELECT last_insert_rowid()",
    rowMode: "array",
    returnValue: "resultRows",
  });
  return id;
}

function tableExists(database, name) {
  const rows = database.exec({
    sql: "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = $name",
    bind: { $name: name },
    rowMode: "array",
    returnValue: "resultRows",
  });
  return rows.length > 0;
}

function columnExists(database, table, column) {
  return database
    .exec({
      sql: "PRAGMA table_info(" + table + ")",
      rowMode: "object",
      returnValue: "resultRows",
    })
    .some((c) => c.name === column);
}

function seedPresetCategories(database) {
  for (const group of PRESET_CATEGORY_GROUPS) {
    database.exec({
      sql: "INSERT OR IGNORE INTO umbrella_categories (name) VALUES ($name)",
      bind: { $name: group.umbrella },
    });
    const [[umbrellaId]] = database.exec({
      sql: "SELECT id FROM umbrella_categories WHERE name = $name",
      bind: { $name: group.umbrella },
      rowMode: "array",
      returnValue: "resultRows",
    });
    for (const name of group.categories) {
      database.exec({
        sql: \`INSERT OR IGNORE INTO categories (name, flow, umbrella_id)
              VALUES ($name, $flow, $umbrellaId)\`,
        bind: { $name: name, $flow: group.flow, $umbrellaId: umbrellaId },
      });
    }
  }
}

function seedPresetAccounts(database) {
  for (const preset of PRESET_ACCOUNTS) {
    const existing = database.exec({
      sql: "SELECT 1 FROM accounts WHERE name = $name LIMIT 1",
      bind: { $name: preset.name },
      rowMode: "array",
      returnValue: "resultRows",
    });
    if (existing.length > 0) continue;
    database.exec({
      sql: "INSERT INTO accounts (name, type) VALUES ($name, $type)",
      bind: { $name: preset.name, $type: preset.type },
    });
  }
}

/**
 * Older builds stored both Transfer presets on one rule under the key
 * "transfer". Point that row at the preset matching its direction and drop
 * substrings that belong only to the other direction so seeding can create it.
 */
function splitLegacyTransferPreset(database) {
  const rows = database.exec({
    sql: "SELECT id, substrings, type FROM rules WHERE preset_key = $presetKey",
    bind: { $presetKey: "transfer" },
    rowMode: "object",
    returnValue: "resultRows",
  });
  if (rows.length === 0) return;
  const rule = rows[0];
  const debitPreset = PRESET_RULES.find((preset) => preset.key === "transfer-debit");
  const creditPreset = PRESET_RULES.find((preset) => preset.key === "transfer-credit");
  const debitKeys = new Set(
    (debitPreset ? debitPreset.substrings : []).map((line) =>
      String(line).trim().toLowerCase(),
    ),
  );
  const creditKeys = new Set(
    (creditPreset ? creditPreset.substrings : []).map((line) =>
      String(line).trim().toLowerCase(),
    ),
  );
  const lines = String(rule.substrings)
    .split(/\\r?\\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const foreign = rule.type === "credit" ? debitKeys : creditKeys;
  const own = rule.type === "credit" ? creditKeys : debitKeys;
  const kept = lines.filter((line) => {
    const key = line.toLowerCase();
    return !(foreign.has(key) && !own.has(key));
  });
  database.exec({
    sql: \`UPDATE rules
          SET substrings = $substrings, preset_key = $presetKey
          WHERE id = $id\`,
    bind: {
      $substrings: kept.join("\\n"),
      $presetKey: rule.type === "credit" ? "transfer-credit" : "transfer-debit",
      $id: rule.id,
    },
  });
}

function seedPresetRules(database) {
  splitLegacyTransferPreset(database);
  for (const preset of PRESET_RULES) {
    const rows = database.exec({
      sql: \`SELECT c.id
            FROM categories c
            JOIN umbrella_categories u ON u.id = c.umbrella_id
            WHERE c.name = $category AND u.name = $umbrella\`,
      bind: { $category: preset.category, $umbrella: preset.umbrella },
      rowMode: "array",
      returnValue: "resultRows",
    });
    if (rows.length === 0) continue;
    const existing = database.exec({
      sql: "SELECT id, substrings FROM rules WHERE preset_key = $presetKey",
      bind: { $presetKey: preset.key },
      rowMode: "object",
      returnValue: "resultRows",
    });
    if (existing.length === 0) {
      database.exec({
        sql: \`INSERT INTO rules
                (substrings, min_amount, max_amount, type, category_id, preset_key)
              VALUES ($substrings, $minAmount, $maxAmount, $type, $categoryId, $presetKey)\`,
        bind: {
          $substrings: preset.substrings.join("\\n"),
          $minAmount: PRESET_RULE_MIN_CENTS,
          $maxAmount: PRESET_RULE_MAX_CENTS,
          $type: preset.type,
          $categoryId: rows[0][0],
          $presetKey: preset.key,
        },
      });
      continue;
    }
    const current = String(existing[0].substrings);
    const seen = new Set(
      current
        .split(/\\r?\\n/)
        .map((line) => line.trim().toLowerCase())
        .filter(Boolean),
    );
    const added = [];
    for (const needle of preset.substrings) {
      const key = String(needle).trim().toLowerCase();
      if (!key || seen.has(key)) continue;
      if (substringUsedElsewhere(database, key, existing[0].id)) continue;
      seen.add(key);
      added.push(String(needle).trim());
    }
    if (added.length === 0) continue;
    const base = current.replace(/\\s+$/, "");
    database.exec({
      sql: "UPDATE rules SET substrings = $substrings WHERE id = $id",
      bind: {
        $substrings: base ? base + "\\n" + added.join("\\n") : added.join("\\n"),
        $id: existing[0].id,
      },
    });
  }
}

/** Category assigned by the most specific matching rule, or null. */
function categoryIdForTransaction(database, description, amount, type) {
  const rules = database.exec({
    sql: \`SELECT id, substrings, min_amount, max_amount, type, category_id
          FROM rules
          ORDER BY id\`,
    rowMode: "object",
    returnValue: "resultRows",
  });
  const haystack = String(description ?? "").toLowerCase();
  let best = null;
  for (const rule of rules) {
    if (rule.type !== type) continue;
    if (amount < rule.min_amount || amount > rule.max_amount) continue;
    let longest = 0;
    for (const line of String(rule.substrings).split(/\\r?\\n/)) {
      const needle = line.trim().toLowerCase();
      if (!needle || !haystack.includes(needle)) continue;
      if (needle.length > longest) longest = needle.length;
    }
    if (longest === 0) continue;
    if (
      !best ||
      longest > best.longest ||
      (longest === best.longest && rule.id < best.id)
    ) {
      best = { categoryId: rule.category_id, longest };
    }
  }
  return best ? best.categoryId : null;
}

/**
 * Full-range rule for this category and direction. Preset rules are preferred.
 * Descriptions learned from categorizing a transaction are stored here so any
 * amount can match.
 */
function learnedRule(database, categoryId, type) {
  const rows = database.exec({
    sql: \`SELECT id, substrings, preset_key
          FROM rules
          WHERE category_id = $categoryId
            AND type = $type
            AND min_amount = $minAmount
            AND max_amount = $maxAmount
          ORDER BY preset_key IS NULL, id\`,
    bind: {
      $categoryId: categoryId,
      $type: type,
      $minAmount: PRESET_RULE_MIN_CENTS,
      $maxAmount: PRESET_RULE_MAX_CENTS,
    },
    rowMode: "object",
    returnValue: "resultRows",
  });
  return rows[0] ?? null;
}

/** One description becomes one substring line. Blank descriptions are skipped. */
function descriptionNeedles(descriptions) {
  const needles = [];
  const seen = new Set();
  for (const raw of descriptions) {
    const line = String(raw ?? "").replace(/[\\r\\n]+/g, " ").trim();
    const key = line.toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    needles.push(line);
  }
  return needles;
}

/** True when some other rule already lists this substring, ignoring letter case. */
function substringUsedElsewhere(database, key, ruleId) {
  const rules = database.exec({
    sql: "SELECT id, substrings FROM rules WHERE id != $id",
    bind: { $id: ruleId },
    rowMode: "object",
    returnValue: "resultRows",
  });
  for (const rule of rules) {
    for (const line of String(rule.substrings).split(/\\r?\\n/)) {
      if (line.trim().toLowerCase() === key) return true;
    }
  }
  return false;
}

/** Drop this exact substring from every rule except the one that now owns it. */
function removeExactSubstring(database, exceptId, key) {
  const rules = database.exec({
    sql: "SELECT id, substrings, preset_key FROM rules WHERE id != $id",
    bind: { $id: exceptId },
    rowMode: "object",
    returnValue: "resultRows",
  });
  for (const rule of rules) {
    const lines = String(rule.substrings)
      .split(/\\r?\\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    const kept = lines.filter((line) => line.toLowerCase() !== key);
    if (kept.length === lines.length) continue;
    if (kept.length === 0 && rule.preset_key == null) {
      database.exec({
        sql: "DELETE FROM rules WHERE id = $id",
        bind: { $id: rule.id },
      });
      continue;
    }
    database.exec({
      sql: "UPDATE rules SET substrings = $substrings WHERE id = $id",
      bind: { $substrings: kept.join("\\n"), $id: rule.id },
    });
  }
}

/** Add each full description as a substring of the category's matching rule. */
function rememberDescriptions(database, categoryId, type, descriptions) {
  const needles = descriptionNeedles(descriptions);
  if (needles.length === 0) return;
  const existing = learnedRule(database, categoryId, type);
  let ruleId;
  if (!existing) {
    database.exec({
      sql: \`INSERT INTO rules
              (substrings, min_amount, max_amount, type, category_id)
            VALUES ($substrings, $minAmount, $maxAmount, $type, $categoryId)\`,
      bind: {
        $substrings: needles.join("\\n"),
        $minAmount: PRESET_RULE_MIN_CENTS,
        $maxAmount: PRESET_RULE_MAX_CENTS,
        $type: type,
        $categoryId: categoryId,
      },
    });
    ruleId = lastId();
  } else {
    ruleId = existing.id;
    const current = String(existing.substrings);
    const have = new Set(
      current
        .split(/\\r?\\n/)
        .map((line) => line.trim().toLowerCase())
        .filter(Boolean),
    );
    const added = needles.filter((needle) => !have.has(needle.toLowerCase()));
    if (added.length > 0) {
      const base = current.replace(/\\s+$/, "");
      database.exec({
        sql: "UPDATE rules SET substrings = $substrings WHERE id = $id",
        bind: {
          $substrings: base ? base + "\\n" + added.join("\\n") : added.join("\\n"),
          $id: ruleId,
        },
      });
    }
  }
  for (const needle of needles) {
    removeExactSubstring(database, ruleId, needle.toLowerCase());
  }
}

/** Assign a category to every uncategorized transaction a rule matches. Returns how many were updated. */
function classifyUncategorized(database) {
  const rows = database.exec({
    sql: \`SELECT id, description, amount, type
          FROM transactions
          WHERE category_id IS NULL\`,
    rowMode: "object",
    returnValue: "resultRows",
  });
  let updated = 0;
  for (const row of rows) {
    const categoryId = categoryIdForTransaction(
      database,
      row.description,
      row.amount,
      row.type,
    );
    if (categoryId == null) continue;
    database.exec({
      sql: "UPDATE transactions SET category_id = $categoryId WHERE id = $id",
      bind: { $categoryId: categoryId, $id: row.id },
    });
    updated += 1;
  }
  return updated;
}

function migrate(database) {
  // Enforce declared foreign keys. This PRAGMA is per-connection, so it must be
  // re-issued every time the database is (re)opened, including after a restore.
  database.exec("PRAGMA foreign_keys = ON;");
  database.exec(\`
    CREATE TABLE IF NOT EXISTS documents (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      filename   TEXT    NOT NULL,
      page_count INTEGER NOT NULL DEFAULT 0,
      text       TEXT    NOT NULL DEFAULT '',
      created_at TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS accounts (
      id   INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT    NOT NULL,
      type TEXT    NOT NULL CHECK (type IN ('dbs', 'ocbc', 'uobCredit', 'paylah', 'ocbcCredit'))
    );

    CREATE TABLE IF NOT EXISTS imports (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      filename     TEXT    NOT NULL,
      file_hash    TEXT    NOT NULL UNIQUE,                  -- SHA-256 hex of the PDF bytes
      page_count   INTEGER NOT NULL DEFAULT 0,
      account_type TEXT    CHECK (account_type IN ('dbs', 'ocbc', 'uobCredit', 'paylah', 'ocbcCredit')),
      created_at   TEXT    NOT NULL DEFAULT (datetime('now'))
    );
  \`);

  // Databases from before categories were unified still have \`subcategories\`.
  // Finish the older transaction-table rebuilds first (they still speak that
  // schema), then rename: the old category becomes an umbrella category, and
  // the old subcategory becomes the category a transaction points at.
  if (tableExists(database, "subcategories")) {
    // Migration: older databases created \`account_id\` as NOT NULL. Transactions
    // can now be saved without an account, so relax that constraint by rebuilding
    // the table when the legacy shape is detected. SQLite can't ALTER a column's
    // nullability in place, hence the copy-and-swap.
    const accountCol = database
      .exec({
        sql: "PRAGMA table_info(transactions)",
        rowMode: "object",
        returnValue: "resultRows",
      })
      .find((c) => c.name === "account_id");
    if (accountCol && accountCol.notnull) {
      database.exec(\`
        PRAGMA foreign_keys = OFF;
        BEGIN;
        CREATE TABLE transactions_new (
          id             INTEGER PRIMARY KEY AUTOINCREMENT,
          date           TEXT    NOT NULL,
          amount         INTEGER NOT NULL CHECK (amount >= 0),
          type           TEXT    NOT NULL CHECK (type IN ('debit', 'credit')),
          description    TEXT    NOT NULL DEFAULT '',
          subcategory_id INTEGER REFERENCES subcategories(id) ON DELETE SET NULL,
          account_id     INTEGER REFERENCES accounts(id) ON DELETE SET NULL,
          created_at     TEXT    NOT NULL DEFAULT (datetime('now'))
        );
        INSERT INTO transactions_new
          SELECT id, date, amount, type, description, subcategory_id, account_id, created_at
          FROM transactions;
        DROP TABLE transactions;
        ALTER TABLE transactions_new RENAME TO transactions;
        COMMIT;
        PRAGMA foreign_keys = ON;

        CREATE INDEX IF NOT EXISTS idx_transactions_date        ON transactions(date);
        CREATE INDEX IF NOT EXISTS idx_transactions_account     ON transactions(account_id);
        CREATE INDEX IF NOT EXISTS idx_transactions_subcategory ON transactions(subcategory_id);
      \`);
    }

    // Migration: transactions used to stand alone. Every row now belongs to an
    // import, so rebuild the table when \`import_id\` is missing. Rows saved before
    // this column existed are attached to one sentinel import (there is no PDF
    // hash for them).
    const hasImportId = database
      .exec({
        sql: "PRAGMA table_info(transactions)",
        rowMode: "object",
        returnValue: "resultRows",
      })
      .some((c) => c.name === "import_id");
    if (!hasImportId) {
      database.exec(\`
        PRAGMA foreign_keys = OFF;
        BEGIN;
        INSERT INTO imports (filename, file_hash)
        SELECT '(before import tracking)', 'legacy'
        WHERE EXISTS (SELECT 1 FROM transactions)
          AND NOT EXISTS (SELECT 1 FROM imports WHERE file_hash = 'legacy');
        CREATE TABLE transactions_new (
          id             INTEGER PRIMARY KEY AUTOINCREMENT,
          date           TEXT    NOT NULL,
          amount         INTEGER NOT NULL CHECK (amount >= 0),
          type           TEXT    NOT NULL CHECK (type IN ('debit', 'credit')),
          description    TEXT    NOT NULL DEFAULT '',
          subcategory_id INTEGER REFERENCES subcategories(id) ON DELETE SET NULL,
          account_id     INTEGER REFERENCES accounts(id) ON DELETE SET NULL,
          import_id      INTEGER NOT NULL REFERENCES imports(id) ON DELETE CASCADE,
          created_at     TEXT    NOT NULL DEFAULT (datetime('now'))
        );
        INSERT INTO transactions_new
          SELECT id, date, amount, type, description, subcategory_id, account_id,
                 (SELECT id FROM imports WHERE file_hash = 'legacy'),
                 created_at
          FROM transactions;
        DROP TABLE transactions;
        ALTER TABLE transactions_new RENAME TO transactions;
        COMMIT;
        PRAGMA foreign_keys = ON;

        CREATE INDEX IF NOT EXISTS idx_transactions_date        ON transactions(date);
        CREATE INDEX IF NOT EXISTS idx_transactions_account     ON transactions(account_id);
        CREATE INDEX IF NOT EXISTS idx_transactions_subcategory ON transactions(subcategory_id);
        CREATE INDEX IF NOT EXISTS idx_transactions_import      ON transactions(import_id);
      \`);
    }

    // Foreign keys stay on so SQLite rewrites references while renaming.
    database.exec(\`
      ALTER TABLE categories RENAME TO umbrella_categories;
      ALTER TABLE subcategories RENAME TO categories;
      ALTER TABLE categories RENAME COLUMN category_id TO umbrella_id;
      ALTER TABLE transactions RENAME COLUMN subcategory_id TO category_id;
      DROP INDEX IF EXISTS idx_transactions_subcategory;
    \`);
  }

  database.exec(\`
    CREATE TABLE IF NOT EXISTS umbrella_categories (
      id   INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT    NOT NULL UNIQUE
    );

    CREATE TABLE IF NOT EXISTS categories (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      name        TEXT    NOT NULL,
      flow        TEXT    NOT NULL CHECK (flow IN ('income', 'expense', 'transfer')),
      umbrella_id INTEGER NOT NULL REFERENCES umbrella_categories(id) ON DELETE CASCADE,
      UNIQUE (umbrella_id, name)
    );

    CREATE TABLE IF NOT EXISTS transactions (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      date        TEXT    NOT NULL,                       -- ISO 'YYYY-MM-DD'
      amount      INTEGER NOT NULL CHECK (amount >= 0),   -- cents; sign lives in "type"
      type        TEXT    NOT NULL CHECK (type IN ('debit', 'credit')),
      description TEXT    NOT NULL DEFAULT '',
      category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
      account_id  INTEGER REFERENCES accounts(id) ON DELETE SET NULL,
      import_id   INTEGER NOT NULL REFERENCES imports(id) ON DELETE CASCADE,
      created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_transactions_date     ON transactions(date);
    CREATE INDEX IF NOT EXISTS idx_transactions_account  ON transactions(account_id);
    CREATE INDEX IF NOT EXISTS idx_transactions_category ON transactions(category_id);
    CREATE INDEX IF NOT EXISTS idx_transactions_import   ON transactions(import_id);
  \`);

  // A rule exists to assign a category. Rows saved before that link have no
  // category to point at, so the table is replaced rather than altered.
  if (tableExists(database, "rules") && !columnExists(database, "rules", "category_id")) {
    database.exec("DROP TABLE rules;");
  }

  database.exec(\`
    CREATE TABLE IF NOT EXISTS rules (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      substrings  TEXT    NOT NULL,                         -- newline-separated; any one may be present
      min_amount  INTEGER NOT NULL CHECK (min_amount >= 0), -- inclusive cents
      max_amount  INTEGER NOT NULL CHECK (max_amount >= 0), -- inclusive cents
      type        TEXT    NOT NULL CHECK (type IN ('debit', 'credit')),
      category_id INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
      preset_key  TEXT,
      CHECK (min_amount <= max_amount)
    );

    CREATE INDEX IF NOT EXISTS idx_rules_category ON rules(category_id);
  \`);

  if (tableExists(database, "rules") && !columnExists(database, "rules", "preset_key")) {
    database.exec("ALTER TABLE rules ADD COLUMN preset_key TEXT;");
  }

  database.exec(\`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_rules_preset_key
      ON rules(preset_key) WHERE preset_key IS NOT NULL;
  \`);

  seedPresetCategories(database);
  seedPresetAccounts(database);
  seedPresetRules(database);
  classifyUncategorized(database);
}

/** Drop blank lines and surrounding space. Any remaining line can match. */
function normalizeSubstrings(raw) {
  const lines = String(raw ?? "")
    .split(/\\r?\\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length === 0) {
    throw new Error("Enter at least one substring, one per line.");
  }
  return lines.join("\\n");
}

function requireCents(value, label) {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(label + " must be zero or more.");
  }
  return value;
}

function requireName(raw, label) {
  const name = String(raw ?? "").trim();
  if (!name) throw new Error("Enter a name for the " + label + ".");
  return name;
}

function requireFlow(flow) {
  if (flow !== "income" && flow !== "expense" && flow !== "transfer") {
    throw new Error("Choose income, expense, or transfer.");
  }
  return flow;
}

function rethrowUnique(err, message) {
  const text = (err && err.message) || String(err);
  if (text.includes("UNIQUE constraint failed")) throw new Error(message);
  throw err;
}

function umbrellaById(id) {
  if (!Number.isInteger(id) || id <= 0) throw new Error("Umbrella category not found.");
  const row = db.exec({
    sql: "SELECT id, name FROM umbrella_categories WHERE id = $id",
    bind: { $id: id },
    rowMode: "object",
    returnValue: "resultRows",
  })[0];
  if (!row) throw new Error("Umbrella category not found.");
  return row;
}

function categoryById(id) {
  if (!Number.isInteger(id) || id <= 0) throw new Error("Category not found.");
  const row = db.exec({
    sql: "SELECT id, name, flow, umbrella_id FROM categories WHERE id = $id",
    bind: { $id: id },
    rowMode: "object",
    returnValue: "resultRows",
  })[0];
  if (!row) throw new Error("Category not found.");
  return row;
}

function countValue(sql, id) {
  const row = db.exec({
    sql,
    bind: { $id: id },
    rowMode: "object",
    returnValue: "resultRows",
  })[0];
  return row ? Number(row.n) : 0;
}

function bindRule(rule) {
  const substrings = normalizeSubstrings(rule.substrings);
  const minAmount = requireCents(rule.minAmount, "Minimum amount");
  const maxAmount = requireCents(rule.maxAmount, "Maximum amount");
  if (minAmount > maxAmount) {
    throw new Error("Minimum amount cannot be greater than the maximum.");
  }
  if (rule.type !== "debit" && rule.type !== "credit") {
    throw new Error("Choose debit or credit.");
  }
  const categoryId = rule.categoryId;
  if (!Number.isInteger(categoryId) || categoryId <= 0) {
    throw new Error("Choose a category.");
  }
  const category = db.exec({
    sql: "SELECT name FROM categories WHERE id = $id",
    bind: { $id: categoryId },
    rowMode: "object",
    returnValue: "resultRows",
  })[0];
  if (!category) throw new Error("Category not found.");
  return {
    substrings,
    minAmount,
    maxAmount,
    type: rule.type,
    categoryId,
    categoryName: category.name,
  };
}

function storedRule(id, bound) {
  return {
    id,
    substrings: bound.substrings,
    min_amount: bound.minAmount,
    max_amount: bound.maxAmount,
    type: bound.type,
    category_id: bound.categoryId,
    category_name: bound.categoryName,
  };
}

const ready = (async () => {
  sqlite3 = await sqlite3InitModule();
  pool = await sqlite3.installOpfsSAHPoolVfs({ directory: VFS_DIR });
  db = new pool.OpfsSAHPoolDb(DB_PATH);
  migrate(db);
})();

const handlers = {
  listDocuments() {
    return db.exec({
      sql: "SELECT id, filename, page_count, text, created_at FROM documents ORDER BY id DESC",
      rowMode: "object",
      returnValue: "resultRows",
    });
  },
  insertDocument(doc) {
    db.exec({
      sql: "INSERT INTO documents (filename, page_count, text) VALUES ($filename, $pageCount, $text)",
      bind: { $filename: doc.filename, $pageCount: doc.pageCount, $text: doc.text },
    });
    return lastId();
  },
  insertUmbrellaCategory(cat) {
    const name = requireName(cat.name, "umbrella category");
    try {
      db.exec({
        sql: "INSERT INTO umbrella_categories (name) VALUES ($name)",
        bind: { $name: name },
      });
    } catch (err) {
      rethrowUnique(err, 'An umbrella category named "' + name + '" already exists.');
    }
    return lastId();
  },
  listUmbrellaCategories() {
    return db.exec({
      sql: "SELECT id, name FROM umbrella_categories ORDER BY name",
      rowMode: "object",
      returnValue: "resultRows",
    });
  },
  updateUmbrellaCategory(cat) {
    umbrellaById(cat.id);
    const name = requireName(cat.name, "umbrella category");
    try {
      db.exec({
        sql: "UPDATE umbrella_categories SET name = $name WHERE id = $id",
        bind: { $name: name, $id: cat.id },
      });
    } catch (err) {
      rethrowUnique(err, 'An umbrella category named "' + name + '" already exists.');
    }
    return { id: cat.id, name };
  },
  countUmbrellaUsage(id) {
    umbrellaById(id);
    return {
      categories: countValue(
        "SELECT COUNT(*) AS n FROM categories WHERE umbrella_id = $id",
        id,
      ),
      transactions: countValue(
        \`SELECT COUNT(*) AS n
          FROM transactions t
          JOIN categories c ON c.id = t.category_id
          WHERE c.umbrella_id = $id\`,
        id,
      ),
      rules: countValue(
        \`SELECT COUNT(*) AS n
          FROM rules r
          JOIN categories c ON c.id = r.category_id
          WHERE c.umbrella_id = $id\`,
        id,
      ),
    };
  },
  deleteUmbrellaCategory(id) {
    umbrellaById(id);
    db.exec({
      sql: "DELETE FROM umbrella_categories WHERE id = $id",
      bind: { $id: id },
    });
    return null;
  },
  insertCategory(cat) {
    const name = requireName(cat.name, "category");
    const flow = requireFlow(cat.flow);
    const umbrellaId = umbrellaById(cat.umbrellaId).id;
    try {
      db.exec({
        sql: "INSERT INTO categories (name, flow, umbrella_id) VALUES ($name, $flow, $umbrellaId)",
        bind: { $name: name, $flow: flow, $umbrellaId: umbrellaId },
      });
    } catch (err) {
      rethrowUnique(err, '"' + name + '" already exists under this umbrella category.');
    }
    return lastId();
  },
  listCategories() {
    return db.exec({
      sql: "SELECT id, name, flow, umbrella_id FROM categories ORDER BY name",
      rowMode: "object",
      returnValue: "resultRows",
    });
  },
  updateCategory(cat) {
    categoryById(cat.id);
    const name = requireName(cat.name, "category");
    const flow = requireFlow(cat.flow);
    const umbrellaId = umbrellaById(cat.umbrellaId).id;
    try {
      db.exec({
        sql: \`UPDATE categories
              SET name = $name, flow = $flow, umbrella_id = $umbrellaId
              WHERE id = $id\`,
        bind: { $name: name, $flow: flow, $umbrellaId: umbrellaId, $id: cat.id },
      });
    } catch (err) {
      rethrowUnique(err, '"' + name + '" already exists under this umbrella category.');
    }
    return { id: cat.id, name, flow, umbrella_id: umbrellaId };
  },
  countCategoryUsage(id) {
    categoryById(id);
    return {
      transactions: countValue(
        "SELECT COUNT(*) AS n FROM transactions WHERE category_id = $id",
        id,
      ),
      rules: countValue(
        "SELECT COUNT(*) AS n FROM rules WHERE category_id = $id",
        id,
      ),
    };
  },
  deleteCategory(id) {
    categoryById(id);
    db.exec({
      sql: "DELETE FROM categories WHERE id = $id",
      bind: { $id: id },
    });
    return null;
  },
  insertAccount(acc) {
    db.exec({
      sql: "INSERT INTO accounts (name, type) VALUES ($name, $type)",
      bind: { $name: acc.name, $type: acc.type },
    });
    return lastId();
  },
  listAccounts() {
    return db.exec({
      sql: "SELECT id, name, type FROM accounts ORDER BY name",
      rowMode: "object",
      returnValue: "resultRows",
    });
  },
  insertRule(rule) {
    const bound = bindRule(rule);
    db.exec({
      sql: \`INSERT INTO rules (substrings, min_amount, max_amount, type, category_id)
            VALUES ($substrings, $minAmount, $maxAmount, $type, $categoryId)\`,
      bind: {
        $substrings: bound.substrings,
        $minAmount: bound.minAmount,
        $maxAmount: bound.maxAmount,
        $type: bound.type,
        $categoryId: bound.categoryId,
      },
    });
    return storedRule(lastId(), bound);
  },
  listRules() {
    return db.exec({
      sql: \`SELECT r.id, r.substrings, r.min_amount, r.max_amount, r.type,
                   r.category_id, c.name AS category_name
            FROM rules r
            JOIN categories c ON c.id = r.category_id
            ORDER BY r.id\`,
      rowMode: "object",
      returnValue: "resultRows",
    });
  },
  updateRule(rule) {
    const bound = bindRule(rule);
    db.exec({
      sql: \`UPDATE rules
            SET substrings = $substrings,
                min_amount = $minAmount,
                max_amount = $maxAmount,
                type = $type,
                category_id = $categoryId
            WHERE id = $id\`,
      bind: {
        $substrings: bound.substrings,
        $minAmount: bound.minAmount,
        $maxAmount: bound.maxAmount,
        $type: bound.type,
        $categoryId: bound.categoryId,
        $id: rule.id,
      },
    });
    const [[changes]] = db.exec({
      sql: "SELECT changes()",
      rowMode: "array",
      returnValue: "resultRows",
    });
    if (!changes) throw new Error("Rule not found.");
    return storedRule(rule.id, bound);
  },
  /** Apply every rule to transactions that still have no category. */
  runRules() {
    return classifyUncategorized(db);
  },
  /**
   * Assign \`categoryId\` to the given transactions. Each description is saved
   * in full as a substring of that category, then other uncategorized
   * transactions are categorized from the rules. Pass a null category to clear
   * the selection without learning a description.
   */
  categorizeTransactions(payload) {
    const ids = [];
    const seen = new Set();
    if (!payload || !Array.isArray(payload.ids) || payload.ids.length === 0) {
      throw new Error("Choose at least one transaction.");
    }
    for (const raw of payload.ids) {
      const id = typeof raw === "number" ? raw : Number(raw);
      if (!Number.isInteger(id) || id <= 0 || seen.has(id)) {
        if (!Number.isInteger(id) || id <= 0) throw new Error("Transaction not found.");
        continue;
      }
      seen.add(id);
      ids.push(id);
    }
    const clear = payload.categoryId == null || payload.categoryId === "";
    let categoryId = null;
    if (!clear) {
      categoryId = typeof payload.categoryId === "number"
        ? payload.categoryId
        : Number(payload.categoryId);
      categoryById(categoryId);
    }
    db.exec("BEGIN");
    try {
      const byType = { debit: [], credit: [] };
      for (const id of ids) {
        const row = db.exec({
          sql: "SELECT id, description, type FROM transactions WHERE id = $id",
          bind: { $id: id },
          rowMode: "object",
          returnValue: "resultRows",
        })[0];
        if (!row) throw new Error("Transaction not found.");
        db.exec({
          sql: "UPDATE transactions SET category_id = $categoryId WHERE id = $id",
          bind: { $categoryId: categoryId, $id: id },
        });
        if (categoryId != null) byType[row.type].push(row.description);
      }
      if (categoryId != null) {
        rememberDescriptions(db, categoryId, "debit", byType.debit);
        rememberDescriptions(db, categoryId, "credit", byType.credit);
        classifyUncategorized(db);
      }
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
    return handlers.listTransactions();
  },
  deleteRule(id) {
    db.exec({
      sql: "DELETE FROM rules WHERE id = $id",
      bind: { $id: id },
    });
    const [[changes]] = db.exec({
      sql: "SELECT changes()",
      rowMode: "array",
      returnValue: "resultRows",
    });
    if (!changes) throw new Error("Rule not found.");
    return null;
  },
  renameAccount(acc) {
    const name = String(acc.name ?? "").trim();
    if (!name) throw new Error("Enter a name for the account.");
    db.exec({
      sql: "UPDATE accounts SET name = $name WHERE id = $id",
      bind: { $name: name, $id: acc.id },
    });
    const [[changes]] = db.exec({
      sql: "SELECT changes()",
      rowMode: "array",
      returnValue: "resultRows",
    });
    if (!changes) throw new Error("Account not found.");
    return name;
  },
  countAccountTransactions(id) {
    const rows = db.exec({
      sql: "SELECT COUNT(*) AS n FROM transactions WHERE account_id = $id",
      bind: { $id: id },
      rowMode: "object",
      returnValue: "resultRows",
    });
    return rows[0] ? rows[0].n : 0;
  },
  deleteAccount(id) {
    db.exec({
      sql: "DELETE FROM accounts WHERE id = $id",
      bind: { $id: id },
    });
    const [[changes]] = db.exec({
      sql: "SELECT changes()",
      rowMode: "array",
      returnValue: "resultRows",
    });
    if (!changes) throw new Error("Account not found.");
    return null;
  },
  findImportByFileHash(fileHash) {
    const rows = db.exec({
      sql: \`SELECT id, filename, file_hash, page_count, account_type, created_at
            FROM imports
            WHERE file_hash = $fileHash\`,
      bind: { $fileHash: fileHash },
      rowMode: "object",
      returnValue: "resultRows",
    });
    return rows[0] ?? null;
  },
  /**
   * Insert an import and its transactions in one transaction. Refuses the write
   * when \`fileHash\` is already stored, so the same PDF can't be imported twice.
   */
  saveImport(imp) {
    if (handlers.findImportByFileHash(imp.fileHash)) {
      throw new Error("This PDF was already imported.");
    }
    db.exec("BEGIN");
    try {
      db.exec({
        sql: \`INSERT INTO imports (filename, file_hash, page_count, account_type)
              VALUES ($filename, $fileHash, $pageCount, $accountType)\`,
        bind: {
          $filename: imp.filename,
          $fileHash: imp.fileHash,
          $pageCount: imp.pageCount,
          $accountType: imp.accountType,
        },
      });
      const importId = lastId();
      for (const txn of imp.transactions) {
        db.exec({
          sql: \`INSERT INTO transactions
                  (date, amount, type, description, category_id, account_id, import_id)
                VALUES ($date, $amount, $type, $description, $categoryId, $accountId, $importId)\`,
          bind: {
            $date: txn.date,
            $amount: txn.amount,
            $type: txn.type,
            $description: txn.description ?? "",
            $categoryId:
              txn.categoryId ??
              categoryIdForTransaction(db, txn.description, txn.amount, txn.type),
            $accountId: txn.accountId ?? null,
            $importId: importId,
          },
        });
      }
      db.exec("COMMIT");
      return importId;
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  },
  insertTransaction(txn) {
    db.exec({
      sql: \`INSERT INTO transactions
              (date, amount, type, description, category_id, account_id, import_id)
            VALUES ($date, $amount, $type, $description, $categoryId, $accountId, $importId)\`,
      bind: {
        $date: txn.date,
        $amount: txn.amount,
        $type: txn.type,
        $description: txn.description ?? "",
        $categoryId:
          txn.categoryId ??
          categoryIdForTransaction(db, txn.description, txn.amount, txn.type),
        $accountId: txn.accountId ?? null,
        $importId: txn.importId,
      },
    });
    return lastId();
  },
  listTransactions() {
    return db.exec({
      sql: \`SELECT t.id, t.date, t.amount, t.type, t.description,
                   t.category_id, t.account_id, t.import_id, t.created_at,
                   c.name AS category_name,
                   u.name AS umbrella_name,
                   a.name AS account_name
            FROM transactions t
            LEFT JOIN categories c ON c.id = t.category_id
            LEFT JOIN umbrella_categories u ON u.id = c.umbrella_id
            LEFT JOIN accounts a ON a.id = t.account_id
            ORDER BY t.date DESC, t.id DESC\`,
      rowMode: "object",
      returnValue: "resultRows",
    });
  },
  deleteTransactions(ids) {
    if (!ids || ids.length === 0) return 0;
    db.exec("BEGIN");
    try {
      for (const id of ids) {
        db.exec({
          sql: "DELETE FROM transactions WHERE id = $id",
          bind: { $id: id },
        });
      }
      db.exec("COMMIT");
      return ids.length;
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  },
  exportDatabase() {
    return sqlite3.capi.sqlite3_js_db_export(db);
  },
  async importDatabase(bytes) {
    // The target file must be closed before the pool can overwrite it.
    db.close();
    try {
      await pool.importDb(DB_PATH, bytes);
    } finally {
      // Reopen regardless so the handle is never left closed.
      db = new pool.OpfsSAHPoolDb(DB_PATH);
      migrate(db);
    }
    return null;
  },
  resetDatabase() {
    db.exec("PRAGMA foreign_keys = OFF;");
    for (const table of [
      "rules",
      "transactions",
      "categories",
      "umbrella_categories",
      "imports",
      "accounts",
      "documents",
    ]) {
      db.exec("DROP TABLE IF EXISTS " + table);
    }
    migrate(db);
    return null;
  },
};

self.onmessage = async (event) => {
  const { id, method, args } = event.data || {};
  try {
    await ready;
    const handler = handlers[method];
    if (!handler) throw new Error("Unknown db method: " + method);
    const result = await handler(...(args || []));
    // Transfer the backing buffer for binary exports to avoid a copy.
    const transfer =
      result && result.buffer instanceof ArrayBuffer ? [result.buffer] : [];
    self.postMessage({ id, result }, transfer);
  } catch (err) {
    self.postMessage({ id, error: (err && err.message) || String(err) });
  }
};
`;

// ---------------------------------------------------------------------------
// Main-thread RPC client
// ---------------------------------------------------------------------------

function assertBrowser() {
  if (typeof window === "undefined") {
    throw new Error("The database is only available in the browser.");
  }
}

// Preflight only the capabilities the main thread actually needs. The
// worker-only `createSyncAccessHandle` is deliberately NOT checked here (it is
// never present on the main thread); the worker surfaces its own error if OPFS
// is genuinely unavailable there.
function assertEnvironment() {
  if (typeof Worker === "undefined") {
    throw new Error(
      "This browser doesn't support Web Workers, which MyBudget needs.",
    );
  }
  if (
    !window.isSecureContext ||
    typeof navigator?.storage?.getDirectory !== "function"
  ) {
    throw new Error(
      "Local storage (OPFS) is unavailable here. Open the app over https:// " +
        "or http://localhost (not a file:// path, LAN IP, or private window).",
    );
  }
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
}

interface Client {
  call<T>(
    method: string,
    args?: unknown[],
    transfer?: Transferable[],
  ): Promise<T>;
}

// Initialization is async and must happen exactly once. Cache the promise so
// concurrent callers share a single worker-backed connection.
let clientPromise: Promise<Client> | null = null;

function createClient(): Promise<Client> {
  assertBrowser();
  assertEnvironment();

  const blob = new Blob([WORKER_SOURCE], { type: "text/javascript" });
  const worker = new Worker(URL.createObjectURL(blob), { type: "module" });

  const pending = new Map<number, Pending>();
  let nextId = 1;

  worker.onmessage = (event: MessageEvent) => {
    const { id, result, error } = event.data || {};
    const entry = pending.get(id);
    if (!entry) return;
    pending.delete(id);
    if (error) entry.reject(new Error(error));
    else entry.resolve(result);
  };

  worker.onerror = (event) => {
    const err = new Error(event.message || "Database worker crashed.");
    for (const entry of pending.values()) entry.reject(err);
    pending.clear();
  };

  const client: Client = {
    call(method, args = [], transfer = []) {
      return new Promise((resolve, reject) => {
        const id = nextId++;
        pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
        worker.postMessage({ id, method, args }, transfer);
      });
    },
  };

  return Promise.resolve(client);
}

function getClient(): Promise<Client> {
  if (!clientPromise) {
    clientPromise = createClient().catch((err) => {
      // Let the next caller retry instead of caching the failure forever.
      clientPromise = null;
      throw err;
    });
  }
  return clientPromise;
}

/** Return all saved documents, newest first. */
export async function listDocuments(): Promise<DocumentRow[]> {
  const client = await getClient();
  return client.call<DocumentRow[]>("listDocuments");
}

/** Insert a parsed document and return its new row id. */
export async function insertDocument(doc: NewDocument): Promise<number> {
  const client = await getClient();
  return client.call<number>("insertDocument", [doc]);
}

/** Insert an umbrella category and return its new row id. */
export async function insertUmbrellaCategory(
  cat: NewUmbrellaCategory,
): Promise<number> {
  const client = await getClient();
  return client.call<number>("insertUmbrellaCategory", [cat]);
}

/** Return all umbrella categories, alphabetically. */
export async function listUmbrellaCategories(): Promise<UmbrellaCategoryRow[]> {
  const client = await getClient();
  return client.call<UmbrellaCategoryRow[]>("listUmbrellaCategories");
}

/** Rename an umbrella category. Returns the stored row. */
export async function updateUmbrellaCategory(
  id: number,
  cat: NewUmbrellaCategory,
): Promise<UmbrellaCategoryRow> {
  const client = await getClient();
  return client.call<UmbrellaCategoryRow>("updateUmbrellaCategory", [
    { id, ...cat },
  ]);
}

/**
 * How many categories belong to this umbrella, and how many transactions and
 * rules point at those categories.
 */
export async function countUmbrellaUsage(id: number): Promise<UmbrellaUsage> {
  const client = await getClient();
  return client.call<UmbrellaUsage>("countUmbrellaUsage", [id]);
}

/**
 * Delete an umbrella category and every category under it. Transactions that
 * used those categories stay, with `category_id` cleared. Rules that assigned
 * them are deleted.
 */
export async function deleteUmbrellaCategory(id: number): Promise<void> {
  const client = await getClient();
  await client.call<null>("deleteUmbrellaCategory", [id]);
}

/** Insert a category under an umbrella category and return its new row id. */
export async function insertCategory(cat: NewCategory): Promise<number> {
  const client = await getClient();
  return client.call<number>("insertCategory", [cat]);
}

/** Return all categories, alphabetically. */
export async function listCategories(): Promise<CategoryRow[]> {
  const client = await getClient();
  return client.call<CategoryRow[]>("listCategories");
}

/** Rename a category, change its flow, or move it under another umbrella. */
export async function updateCategory(
  id: number,
  cat: NewCategory,
): Promise<CategoryRow> {
  const client = await getClient();
  return client.call<CategoryRow>("updateCategory", [{ id, ...cat }]);
}

/** How many transactions use this category, and how many rules assign it. */
export async function countCategoryUsage(id: number): Promise<CategoryUsage> {
  const client = await getClient();
  return client.call<CategoryUsage>("countCategoryUsage", [id]);
}

/**
 * Delete a category. Linked transactions stay, with `category_id` cleared.
 * Rules that assigned it are deleted.
 */
export async function deleteCategory(id: number): Promise<void> {
  const client = await getClient();
  await client.call<null>("deleteCategory", [id]);
}

/** Insert an account and return its new row id. */
export async function insertAccount(acc: NewAccount): Promise<number> {
  const client = await getClient();
  return client.call<number>("insertAccount", [acc]);
}

/** Return all accounts, alphabetically. */
export async function listAccounts(): Promise<AccountRow[]> {
  const client = await getClient();
  return client.call<AccountRow[]>("listAccounts");
}

/** Insert a rule and return the stored row (amounts in cents). */
export async function insertRule(rule: NewRule): Promise<RuleRow> {
  const client = await getClient();
  return client.call<RuleRow>("insertRule", [rule]);
}

/** Return all rules, oldest first. */
export async function listRules(): Promise<RuleRow[]> {
  const client = await getClient();
  return client.call<RuleRow[]>("listRules");
}

/** Replace a rule's match criteria and the category it assigns. Returns the stored row. */
export async function updateRule(id: number, rule: NewRule): Promise<RuleRow> {
  const client = await getClient();
  return client.call<RuleRow>("updateRule", [{ id, ...rule }]);
}

/** Delete a rule. */
export async function deleteRule(id: number): Promise<void> {
  const client = await getClient();
  await client.call<null>("deleteRule", [id]);
}

/**
 * Apply every rule to transactions that still have no category.
 * Returns how many transactions received a category.
 */
export async function runRules(): Promise<number> {
  const client = await getClient();
  return client.call<number>("runRules");
}

/**
 * Assign `categoryId` to these transactions and remember each full description
 * as a substring of that category, so later transactions with the same
 * description are categorized automatically. Pass `null` to clear the category
 * without saving a description. Returns the full transaction list.
 */
export async function categorizeTransactions(
  ids: number[],
  categoryId: number | null,
): Promise<TransactionRow[]> {
  const client = await getClient();
  return client.call<TransactionRow[]>("categorizeTransactions", [
    { ids, categoryId },
  ]);
}

/** Rename an account. Returns the stored name. */
export async function renameAccount(id: number, name: string): Promise<string> {
  const client = await getClient();
  return client.call<string>("renameAccount", [{ id, name }]);
}

/** How many transactions are linked to this account. */
export async function countAccountTransactions(id: number): Promise<number> {
  const client = await getClient();
  return client.call<number>("countAccountTransactions", [id]);
}

/**
 * Delete an account. Linked transactions stay; their `account_id` is cleared
 * by the foreign key (`ON DELETE SET NULL`).
 */
export async function deleteAccount(id: number): Promise<void> {
  const client = await getClient();
  await client.call<null>("deleteAccount", [id]);
}

/**
 * Look up an import by the SHA-256 of its PDF. Returns null when this file has
 * not been imported yet.
 */
export async function findImportByFileHash(
  fileHash: string,
): Promise<ImportRow | null> {
  const client = await getClient();
  return client.call<ImportRow | null>("findImportByFileHash", [fileHash]);
}

/**
 * Save a statement import and every transaction parsed from it. Throws when a
 * PDF with the same hash is already stored. Returns the new import id.
 */
export async function saveImport(imp: NewImport): Promise<number> {
  const client = await getClient();
  return client.call<number>("saveImport", [imp]);
}

/** Insert a transaction and return its new row id. */
export async function insertTransaction(txn: NewTransaction): Promise<number> {
  const client = await getClient();
  return client.call<number>("insertTransaction", [txn]);
}

/** Return all transactions, newest first. */
export async function listTransactions(): Promise<TransactionRow[]> {
  const client = await getClient();
  return client.call<TransactionRow[]>("listTransactions");
}

/** Delete transactions by id. Returns the number of ids requested. */
export async function deleteTransactions(ids: number[]): Promise<number> {
  const client = await getClient();
  return client.call<number>("deleteTransactions", [ids]);
}

/** Serialize the entire database to a byte array (for "Download backup"). */
export async function exportDatabase(): Promise<Uint8Array> {
  const client = await getClient();
  return client.call<Uint8Array>("exportDatabase");
}

/**
 * Replace the current database with the contents of a backup file (for
 * "Restore backup"). The worker reopens the connection afterwards so subsequent
 * queries see the restored data.
 */
export async function importDatabase(
  bytes: Uint8Array | ArrayBuffer,
): Promise<void> {
  const client = await getClient();
  // Transfer the buffer to the worker to avoid copying the whole DB.
  const buffer = bytes instanceof Uint8Array ? bytes.buffer : bytes;
  await client.call<null>("importDatabase", [bytes], [buffer as ArrayBuffer]);
}

/**
 * Delete every saved row and recreate the schema. Preset categories and rules
 * are seeded again by the same startup migration.
 */
export async function resetDatabase(): Promise<void> {
  const client = await getClient();
  await client.call<null>("resetDatabase");
}
