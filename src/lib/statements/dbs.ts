// DBS/POSB consolidated statement parser.
//
// These statements are borderless tables, but each column sits at a stable
// x-coordinate, so rows are rebuilt from geometry.

import type { Line, StatementParser, StatementTransaction } from "@/lib/statements/types";

/** Account number fragment that appears on this DBS statement. */
const DBS_MARKER = "52880148A";

const DATE_RE = /^\d{2}\/\d{2}\/\d{4}$/;
const NUM_RE = /^-?\d{1,3}(,\d{3})*(\.\d+)?$|^-?\d+(\.\d+)?$/;

// Column x-boundaries, calibrated from the statement layout (page width ~594pt):
//   date ~45 | description ~113 | withdrawal ~337-397 | deposit ~430-476 | balance ~493+
const COL = { descMax: 330, withdrawalMax: 415, depositMax: 490 } as const;

function classifyAmount(x: number): "withdrawal" | "deposit" | "balance" {
  if (x < COL.withdrawalMax) return "withdrawal";
  if (x < COL.depositMax) return "deposit";
  return "balance";
}

function parseLines(pages: Line[][]): StatementTransaction[] {
  const txns: StatementTransaction[] = [];
  let cur: StatementTransaction | null = null;

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

      // Skip headers, page furniture and the brought/carried-forward markers.
      if (/Balance (Brought|Carried) Forward|^Total\b|^Page \d+/.test(text)) {
        if (/Carried Forward/.test(text)) flush();
        continue;
      }

      const first = items[0];
      if (first && DATE_RE.test(first.str)) {
        flush();
        cur = {
          date: first.str,
          description: "",
          amount: "",
          transactionType: "debit",
        };
        for (const it of items.slice(1)) {
          if (NUM_RE.test(it.str)) {
            const col = classifyAmount(it.x);
            // The balance column is a running total, not a transaction amount —
            // drop it. A withdrawal is money out (debit); a deposit is money in
            // (credit).
            if (col === "withdrawal") {
              cur.amount = it.str;
              cur.transactionType = "debit";
            } else if (col === "deposit") {
              cur.amount = it.str;
              cur.transactionType = "credit";
            }
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

export const dbsParser: StatementParser = {
  accountType: "dbs",
  detect(pageText: string) {
    return pageText.includes(DBS_MARKER);
  },
  parse: parseLines,
};
