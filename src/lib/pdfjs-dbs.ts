// Browser-only DBS/POSB statement parser built on pdf.js.
//
// pdf.js gives us every text run with its (x, y) position on the page. DBS
// consolidated statements are borderless tables, but each column sits at a
// stable x-coordinate, so we can rebuild rows from geometry alone — all in a
// few hundred KB of JS, with no runtime download.
//
// Everything runs client-side; the PDF bytes never leave the browser.

import type {
  TextItem,
  TextContent,
} from "pdfjs-dist/types/src/display/api";

// Keep the worker version in lockstep with the installed `pdfjs-dist`.
const PDFJS_VERSION = "4.10.38";
const WORKER_SRC = `https://cdn.jsdelivr.net/npm/pdfjs-dist@${PDFJS_VERSION}/build/pdf.worker.min.mjs`;

export interface DbsTransaction {
  date: string; // DD/MM/YYYY
  account: string | null; // account number this txn belongs to
  description: string;
  withdrawal: string; // "" when not a withdrawal
  deposit: string; // "" when not a deposit
  balance: string; // running balance after the txn
}

export interface ParseResult {
  pageCount: number;
  transactions: DbsTransaction[];
}

const DATE_RE = /^\d{2}\/\d{2}\/\d{4}$/;
const NUM_RE = /^-?\d{1,3}(,\d{3})*(\.\d+)?$|^-?\d+(\.\d+)?$/;

// Column x-boundaries, calibrated from the statement layout (page width ~594pt):
//   date ~45 | description ~113 | withdrawal ~337-397 | deposit ~430-476 | balance ~493+
const COL = { descMax: 330, withdrawalMax: 415, depositMax: 490 } as const;

type Positioned = { x: number; str: string };
type Line = { y: number; items: Positioned[] };

function classifyAmount(x: number): "withdrawal" | "deposit" | "balance" {
  if (x < COL.withdrawalMax) return "withdrawal";
  if (x < COL.depositMax) return "deposit";
  return "balance";
}

/** Group a page's text items into visual lines, top-to-bottom, left-to-right. */
function toLines(items: TextItem[]): Line[] {
  const buckets: Line[] = [];
  for (const it of items) {
    const str = it.str.trim();
    if (!str) continue;
    const x = it.transform[4];
    const y = it.transform[5];
    const line = buckets.find((b) => Math.abs(b.y - y) <= 3);
    if (line) line.items.push({ x, str });
    else buckets.push({ y, items: [{ x, str }] });
  }
  buckets.sort((a, b) => b.y - a.y); // y descending = top of page first
  for (const b of buckets) b.items.sort((a, c) => a.x - c.x);
  return buckets;
}

function parseLines(pages: Line[][]): DbsTransaction[] {
  const txns: DbsTransaction[] = [];
  let cur: DbsTransaction | null = null;
  let account: string | null = null;

  const flush = () => {
    if (cur) {
      cur.description = cur.description.trim();
      txns.push(cur);
      cur = null;
    }
  };

  for (const lines of pages) {
    for (const { items } of lines) {
      const text = items.map((i) => i.str).join(" ");

      // Remember which account section the following rows belong to.
      const acc = text.match(/Account No\.\s*([\d-]+)/);
      if (acc) account = acc[1];

      // Skip headers, page furniture and the brought/carried-forward markers.
      if (/Balance (Brought|Carried) Forward|^Total\b|^Page \d+/.test(text)) {
        if (/Carried Forward/.test(text)) flush();
        continue;
      }

      const first = items[0];
      if (first && DATE_RE.test(first.str)) {
        // A new transaction row.
        flush();
        cur = {
          date: first.str,
          account,
          description: "",
          withdrawal: "",
          deposit: "",
          balance: "",
        };
        for (const it of items.slice(1)) {
          if (NUM_RE.test(it.str)) {
            cur[classifyAmount(it.x)] = it.str;
          } else {
            cur.description += (cur.description ? " " : "") + it.str;
          }
        }
      } else if (cur) {
        // Continuation line: extra description detail in the description column.
        for (const it of items) {
          if (it.x < COL.descMax && !NUM_RE.test(it.str)) {
            cur.description += (cur.description ? " " : "") + it.str;
          }
        }
      }
    }
  }
  flush();
  return txns;
}

/**
 * Parse a DBS/POSB consolidated statement PDF entirely in the browser.
 */
export async function parseDbsStatement(
  bytes: Uint8Array,
  onStatus?: (msg: string) => void,
): Promise<ParseResult> {
  onStatus?.("Loading PDF engine...");
  const pdfjs = await import("pdfjs-dist");
  pdfjs.GlobalWorkerOptions.workerSrc = WORKER_SRC;

  onStatus?.("Reading pages...");
  const doc = await pdfjs.getDocument({ data: bytes }).promise;
  const pages: Line[][] = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const content: TextContent = await page.getTextContent();
    pages.push(toLines(content.items as TextItem[]));
  }

  onStatus?.("Extracting transactions...");
  const transactions = parseLines(pages);
  return { pageCount: doc.numPages, transactions };
}
