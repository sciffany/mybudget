// OCBC deposit-account statement parser (360 Account and the same layout).
//
// Amounts are right-aligned, so a larger figure starts further left. Column
// ownership is decided from the start x against the stable gaps between
// Withdrawal, Deposit, and Balance — not from the header label positions.
// Withdrawal is money out (debit); deposit is money in (credit). The balance
// column is a running total and is dropped.

import type { Line, StatementParser, StatementTransaction } from "@/lib/statements/types";
import type { TransactionType } from "@/lib/db";

/** Footer company name printed on every OCBC deposit statement page. */
const OCBC_MARKER = "Oversea-Chinese Banking Corporation";

const MONTHS: Record<string, number> = {
  JAN: 1,
  FEB: 2,
  MAR: 3,
  APR: 4,
  MAY: 5,
  JUN: 6,
  JUL: 7,
  AUG: 8,
  SEP: 9,
  OCT: 10,
  NOV: 11,
  DEC: 12,
};

const TXN_DATE_RE = /^(\d{2}) ([A-Z]{3})$/;
const PERIOD_RE = /(\d{1,2}) ([A-Z]{3}) (\d{4}) TO (\d{1,2}) ([A-Z]{3}) (\d{4})/;
const AMOUNT_RE = /^\d{1,3}(,\d{3})*\.\d{2}$/;

// Start-x gaps measured from a 360 Account statement (page width ~595pt).
// Right edges sit near 379 (withdrawal), 464 (deposit) and 560 (balance).
const COL = {
  descMin: 120,
  withdrawalMin: 320,
  depositMin: 400,
  balanceMin: 500,
} as const;

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function lineText(items: Line["items"]): string {
  return items.map((item) => item.str).join(" ");
}

/** "1 AUG 2025 TO 31 AUG 2025" supplies the year for "DD MON" transaction dates. */
function findStatementEnd(pages: Line[][]): { year: number; month: number } | null {
  for (const lines of pages) {
    for (const { items } of lines) {
      const match = PERIOD_RE.exec(lineText(items));
      const month = match && MONTHS[match[5]];
      if (match && month) return { year: Number(match[6]), month };
    }
  }
  return null;
}

/**
 * "09 AUG" on an August 2025 statement is 09/08/2025. A month later than the
 * statement's end month belongs to the previous year (December rows on a
 * statement that ends in January).
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

function isTransactionDate(str: string): boolean {
  const match = TXN_DATE_RE.exec(str);
  return Boolean(match && MONTHS[match[2]]);
}

/** Backs of duplex statements are a transaction-code glossary with no rows. */
function isTransactionPage(lines: Line[]): boolean {
  return lines.some(({ items }) => {
    if (/BALANCE [BC]\/F/.test(lineText(items))) return true;
    const first = items[0];
    return Boolean(first && isTransactionDate(first.str));
  });
}

function isSkippable(text: string): boolean {
  return (
    /BALANCE [BC]\/F/.test(text) ||
    /^Total\b/.test(text) ||
    /Average Balance/.test(text) ||
    /Deposit Insurance/.test(text) ||
    /Oversea-Chinese/.test(text) ||
    /^Page \d+ of/.test(text) ||
    /STATEMENT OF ACCOUNT/.test(text) ||
    /Account No\./.test(text) ||
    (/Withdrawal/.test(text) && /Deposit/.test(text))
  );
}

function parseLines(pages: Line[][]): StatementTransaction[] {
  const statement = findStatementEnd(pages);
  const txns: StatementTransaction[] = [];
  let cur: StatementTransaction | null = null;

  const flush = () => {
    if (!cur) return;
    cur.description = cur.description.trim();
    txns.push(cur);
    cur = null;
  };

  for (const lines of pages) {
    if (!isTransactionPage(lines)) continue;
    for (const { items } of lines) {
      const text = lineText(items);
      if (isSkippable(text)) continue;

      const first = items[0];
      const dateMatch = first ? TXN_DATE_RE.exec(first.str) : null;
      if (dateMatch && MONTHS[dateMatch[2]]) {
        if (!statement) {
          throw new Error(
            "OCBC statement is missing a statement period, so transaction years cannot be determined.",
          );
        }
        flush();
        let amount = "";
        let transactionType: TransactionType = "debit";
        let description = "";
        for (const it of items.slice(1)) {
          if (isTransactionDate(it.str)) continue;
          if (AMOUNT_RE.test(it.str) && it.x >= COL.withdrawalMin) {
            if (it.x >= COL.balanceMin) continue;
            amount = it.str;
            transactionType = it.x >= COL.depositMin ? "credit" : "debit";
          } else if (it.x >= COL.descMin && it.x < COL.withdrawalMin) {
            description += (description ? " " : "") + it.str;
          }
        }
        cur = {
          date: toStatementDate(dateMatch[1], dateMatch[2], statement),
          description,
          amount,
          transactionType,
        };
      } else if (cur && first && first.x >= COL.descMin && first.x < COL.withdrawalMin) {
        for (const it of items) {
          if (it.x >= COL.descMin && it.x < COL.withdrawalMin && !AMOUNT_RE.test(it.str)) {
            cur.description += (cur.description ? " " : "") + it.str;
          }
        }
      }
    }
  }
  flush();
  return txns.filter((txn) => txn.amount !== "");
}

export const ocbcParser: StatementParser = {
  accountType: "ocbc",
  detect(pageText: string) {
    return (
      pageText.includes(OCBC_MARKER) &&
      pageText.includes("BALANCE B/F") &&
      pageText.includes("Withdrawal")
    );
  },
  parse: parseLines,
};
