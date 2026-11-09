// DBS PayLah! wallet statement parser.
//
// Each transaction is one dated line plus a "REF NO" continuation. Money
// direction is the CR/DB marker beside the amount, not a separate column.

import type { Line, StatementParser, StatementTransaction } from "@/lib/statements/types";
import type { TransactionType } from "@/lib/db";

/** Footer product code printed on every PayLah! wallet statement page. */
const PAYLAH_MARKER = "PDS_GCSPPAYLAH";

const MONTHS: Record<string, number> = {
  Jan: 1,
  Feb: 2,
  Mar: 3,
  Apr: 4,
  May: 5,
  Jun: 6,
  Jul: 7,
  Aug: 8,
  Sep: 9,
  Oct: 10,
  Nov: 11,
  Dec: 12,
};

const TXN_DATE_RE = /^(\d{2}) ([A-Za-z]{3})$/;
const STMT_DATE_RE = /^(\d{2}) ([A-Za-z]{3}) (\d{4})$/;
const AMOUNT_RE = /^\d{1,3}(,\d{3})*\.\d{2}$/;
const REF_RE = /^REF NO:?\.?/i;

/** Amount and CR/DB sit on the right; description text stays left of this. */
const AMOUNT_MIN_X = 480;

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** Statement date "29 Aug 2025" supplies the year for "DD Mon" transaction dates. */
function findStatementDate(pages: Line[][]): { year: number; month: number } | null {
  for (const lines of pages) {
    for (const { items } of lines) {
      for (const it of items) {
        const match = STMT_DATE_RE.exec(it.str);
        const month = match && MONTHS[match[2]];
        if (match && month) return { year: Number(match[3]), month };
      }
    }
  }
  return null;
}

/**
 * "31 Jul" on an August 2025 statement is 31/07/2025. A month later than the
 * statement month belongs to the previous year (December rows on a January
 * statement).
 */
function toStatementDate(
  day: string,
  mon: string,
  statement: { year: number; month: number },
): string {
  const month = MONTHS[mon];
  const year = month > statement.month ? statement.year - 1 : statement.year;
  return `${day}/${pad2(month)}/${year}`;
}

function parseLines(pages: Line[][]): StatementTransaction[] {
  const statement = findStatementDate(pages);
  const txns: StatementTransaction[] = [];
  let cur: StatementTransaction | null = null;

  const flush = () => {
    if (!cur) return;
    cur.description = cur.description.trim();
    txns.push(cur);
    cur = null;
  };

  for (const lines of pages) {
    for (const { items } of lines) {
      const text = items.map((i) => i.str).join(" ");
      const first = items[0];
      const dateMatch = first ? TXN_DATE_RE.exec(first.str) : null;

      if (dateMatch && MONTHS[dateMatch[2]]) {
        if (!statement) {
          throw new Error(
            "PayLah statement is missing a statement date, so transaction years cannot be determined.",
          );
        }
        flush();
        let amount = "";
        let transactionType: TransactionType = "debit";
        let description = "";
        for (const it of items.slice(1)) {
          if (it.x >= AMOUNT_MIN_X && (it.str === "CR" || it.str === "DB")) {
            transactionType = it.str === "CR" ? "credit" : "debit";
          } else if (it.x >= AMOUNT_MIN_X && AMOUNT_RE.test(it.str)) {
            amount = it.str;
          } else if (it.x < AMOUNT_MIN_X) {
            description += (description ? " " : "") + it.str;
          }
        }
        cur = {
          date: toStatementDate(dateMatch[1], dateMatch[2], statement),
          description,
          amount,
          transactionType,
        };
      } else if (cur && REF_RE.test(text)) {
        cur.description += (cur.description ? " " : "") + text;
      }
    }
  }
  flush();
  return txns.filter((txn) => txn.amount !== "");
}

export const paylahParser: StatementParser = {
  accountType: "paylah",
  detect(pageText: string) {
    return pageText.includes(PAYLAH_MARKER);
  },
  parse: parseLines,
};
