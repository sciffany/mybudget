// Browser-only persistent storage for MyBudget, built on SQLite compiled to
// WebAssembly (`@sqlite.org/sqlite-wasm`).
//
// We use the OPFS "SAHPool" VFS instead of the plain `OpfsDb`/worker setup.
// SAHPool runs on the main thread and does NOT require the cross-origin
// isolation headers (COOP/COEP) that a worker-backed OPFS db needs — which
// matters because this app ships as a fully static export (`output: "export"`)
// with no server to set those headers. Data is persisted in the browser's
// Origin Private File System and survives reloads.
//
// Everything here runs client-side; the database bytes never leave the browser.

import type {
  Sqlite3Static,
  SAHPoolUtil,
  OpfsSAHPoolDatabase,
} from "@sqlite.org/sqlite-wasm";

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

interface DbHandle {
  sqlite3: Sqlite3Static;
  pool: SAHPoolUtil;
  db: OpfsSAHPoolDatabase;
}

// Initialization is async and must happen exactly once. Cache the promise so
// concurrent callers share a single database connection.
let handlePromise: Promise<DbHandle> | null = null;

function assertBrowser() {
  if (typeof window === "undefined") {
    throw new Error("The database is only available in the browser.");
  }
}

/** Create the schema if it doesn't exist yet. Safe to call repeatedly. */
function migrate(db: OpfsSAHPoolDatabase) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS documents (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      filename   TEXT    NOT NULL,
      page_count INTEGER NOT NULL DEFAULT 0,
      text       TEXT    NOT NULL DEFAULT '',
      created_at TEXT    NOT NULL DEFAULT (datetime('now'))
    );
  `);
}

async function init(): Promise<DbHandle> {
  assertBrowser();
  const sqlite3InitModule = (await import("@sqlite.org/sqlite-wasm")).default;
  const sqlite3 = await sqlite3InitModule();
  const pool = await sqlite3.installOpfsSAHPoolVfs({ directory: VFS_DIR });
  const db = new pool.OpfsSAHPoolDb(DB_PATH);
  migrate(db);
  return { sqlite3, pool, db };
}

function getHandle(): Promise<DbHandle> {
  if (!handlePromise) {
    handlePromise = init().catch((err) => {
      // Let the next caller retry instead of caching the failure forever.
      handlePromise = null;
      throw err;
    });
  }
  return handlePromise;
}

/** Return all saved documents, newest first. */
export async function listDocuments(): Promise<DocumentRow[]> {
  const { db } = await getHandle();
  const rows = db.exec({
    sql: `SELECT id, filename, page_count, text, created_at
          FROM documents
          ORDER BY id DESC`,
    rowMode: "object",
    returnValue: "resultRows",
  });
  return rows as unknown as DocumentRow[];
}

/** Insert a parsed document and return its new row id. */
export async function insertDocument(doc: NewDocument): Promise<number> {
  const { db } = await getHandle();
  db.exec({
    sql: `INSERT INTO documents (filename, page_count, text)
          VALUES ($filename, $pageCount, $text)`,
    bind: {
      $filename: doc.filename,
      $pageCount: doc.pageCount,
      $text: doc.text,
    },
  });
  const [[id]] = db.exec({
    sql: "SELECT last_insert_rowid()",
    rowMode: "array",
    returnValue: "resultRows",
  }) as unknown as [[number]];
  return id;
}

/** Serialize the entire database to a byte array (for "Download backup"). */
export async function exportDatabase(): Promise<Uint8Array> {
  const { sqlite3, db } = await getHandle();
  return sqlite3.capi.sqlite3_js_db_export(db);
}

/**
 * Replace the current database with the contents of a backup file (for
 * "Restore backup"). The in-memory connection is reopened afterwards so
 * subsequent queries see the restored data.
 */
export async function importDatabase(
  bytes: Uint8Array | ArrayBuffer,
): Promise<void> {
  const current = await getHandle();
  const { sqlite3, pool } = current;
  // The target file must be closed before the pool can overwrite it.
  current.db.close();
  try {
    await pool.importDb(DB_PATH, bytes);
  } finally {
    // Reopen regardless so the handle is never left in a closed state, and
    // publish the fresh connection for subsequent queries.
    const db = new pool.OpfsSAHPoolDb(DB_PATH);
    migrate(db);
    handlePromise = Promise.resolve({ sqlite3, pool, db });
  }
}
