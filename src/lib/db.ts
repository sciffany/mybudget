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
/** Semantic nature of a subcategory. */
export type Flow = "income" | "expense" | "transfer";
/** Institution/product an account belongs to. */
export type AccountType =
  | "dbs"
  | "ocbc"
  | "uobCredit"
  | "paylah"
  | "ocbcCredit";

export interface CategoryRow {
  id: number;
  name: string;
}

export interface SubcategoryRow {
  id: number;
  name: string;
  flow: Flow;
  category_id: number;
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
  subcategory_id: number | null;
  account_id: number | null;
  /** The statement import these rows came from. */
  import_id: number;
  created_at: string;
  /** Parent category of the assigned subcategory, when one is set. */
  category_name: string | null;
  /** Account this transaction belongs to, when one is set. */
  account_name: string | null;
}

export interface NewCategory {
  name: string;
}
export interface NewSubcategory {
  name: string;
  flow: Flow;
  categoryId: number;
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
  subcategoryId?: number | null;
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

    CREATE TABLE IF NOT EXISTS categories (
      id   INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT    NOT NULL UNIQUE
    );

    CREATE TABLE IF NOT EXISTS subcategories (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      name        TEXT    NOT NULL,
      flow        TEXT    NOT NULL CHECK (flow IN ('income', 'expense', 'transfer')),
      category_id INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
      UNIQUE (category_id, name)
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

    CREATE TABLE IF NOT EXISTS transactions (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      date           TEXT    NOT NULL,                       -- ISO 'YYYY-MM-DD'
      amount         INTEGER NOT NULL CHECK (amount >= 0),   -- cents; sign lives in "type"
      type           TEXT    NOT NULL CHECK (type IN ('debit', 'credit')),
      description    TEXT    NOT NULL DEFAULT '',
      subcategory_id INTEGER REFERENCES subcategories(id) ON DELETE SET NULL,
      account_id     INTEGER REFERENCES accounts(id) ON DELETE SET NULL,
      import_id      INTEGER NOT NULL REFERENCES imports(id) ON DELETE CASCADE,
      created_at     TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_transactions_date        ON transactions(date);
    CREATE INDEX IF NOT EXISTS idx_transactions_account     ON transactions(account_id);
    CREATE INDEX IF NOT EXISTS idx_transactions_subcategory ON transactions(subcategory_id);
  \`);

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

  // Created after the migration above: older databases don't have \`import_id\`
  // until that rebuild finishes, so this index can't live in the initial batch.
  database.exec(
    "CREATE INDEX IF NOT EXISTS idx_transactions_import ON transactions(import_id);",
  );
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
  insertCategory(cat) {
    db.exec({
      sql: "INSERT INTO categories (name) VALUES ($name)",
      bind: { $name: cat.name },
    });
    return lastId();
  },
  listCategories() {
    return db.exec({
      sql: "SELECT id, name FROM categories ORDER BY name",
      rowMode: "object",
      returnValue: "resultRows",
    });
  },
  insertSubcategory(sub) {
    db.exec({
      sql: "INSERT INTO subcategories (name, flow, category_id) VALUES ($name, $flow, $categoryId)",
      bind: { $name: sub.name, $flow: sub.flow, $categoryId: sub.categoryId },
    });
    return lastId();
  },
  listSubcategories() {
    return db.exec({
      sql: "SELECT id, name, flow, category_id FROM subcategories ORDER BY name",
      rowMode: "object",
      returnValue: "resultRows",
    });
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
                  (date, amount, type, description, subcategory_id, account_id, import_id)
                VALUES ($date, $amount, $type, $description, $subcategoryId, $accountId, $importId)\`,
          bind: {
            $date: txn.date,
            $amount: txn.amount,
            $type: txn.type,
            $description: txn.description ?? "",
            $subcategoryId: txn.subcategoryId ?? null,
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
              (date, amount, type, description, subcategory_id, account_id, import_id)
            VALUES ($date, $amount, $type, $description, $subcategoryId, $accountId, $importId)\`,
      bind: {
        $date: txn.date,
        $amount: txn.amount,
        $type: txn.type,
        $description: txn.description ?? "",
        $subcategoryId: txn.subcategoryId ?? null,
        $accountId: txn.accountId ?? null,
        $importId: txn.importId,
      },
    });
    return lastId();
  },
  listTransactions() {
    return db.exec({
      sql: \`SELECT t.id, t.date, t.amount, t.type, t.description,
                   t.subcategory_id, t.account_id, t.import_id, t.created_at,
                   c.name AS category_name,
                   a.name AS account_name
            FROM transactions t
            LEFT JOIN subcategories s ON s.id = t.subcategory_id
            LEFT JOIN categories c ON c.id = s.category_id
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
    throw new Error("This browser doesn't support Web Workers, which MyBudget needs.");
  }
  if (!window.isSecureContext || typeof navigator?.storage?.getDirectory !== "function") {
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
  call<T>(method: string, args?: unknown[], transfer?: Transferable[]): Promise<T>;
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

/** Insert a category and return its new row id. */
export async function insertCategory(cat: NewCategory): Promise<number> {
  const client = await getClient();
  return client.call<number>("insertCategory", [cat]);
}

/** Return all categories, alphabetically. */
export async function listCategories(): Promise<CategoryRow[]> {
  const client = await getClient();
  return client.call<CategoryRow[]>("listCategories");
}

/** Insert a subcategory and return its new row id. */
export async function insertSubcategory(sub: NewSubcategory): Promise<number> {
  const client = await getClient();
  return client.call<number>("insertSubcategory", [sub]);
}

/** Return all subcategories, alphabetically. */
export async function listSubcategories(): Promise<SubcategoryRow[]> {
  const client = await getClient();
  return client.call<SubcategoryRow[]>("listSubcategories");
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
