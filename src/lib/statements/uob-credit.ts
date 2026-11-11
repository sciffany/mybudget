// UOB credit-card statement parser.
//
// Each purchase is a post date, a transaction date, a description, and a
// right-aligned SGD amount. A "Ref No." line continues the description.
// Payments and refunds carry a CR marker and are money in (credit); other
// amounts are card charges (debit). Summary rows (previous balance, subtotal,
// total balance) are not transactions.

import type { Line, StatementParser, StatementTransaction } from "@/lib/statements/types";
import type { TransactionType } from "@/lib/db";

/** Footer company name printed on every UOB credit-card statement page. */
const UOB_MARKER = "United Overseas Bank Limited";
/** Title on the first page of a UOB credit-card statement. */
const UOB_CREDIT_MARKER = "Credit Card(s) Statement";

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
const STMT_DATE_RE = /^(\d{2}) ([A-Z]{3}) (\d{4})$/;
const AMOUNT_RE = /^(\d{1,3}(,\d{3})*\.\d{2})(\s*CR)?$/i;

// Start-x gaps measured from a Preferred Platinum Visa statement (A4, ~595pt).
// Post date ~61, transaction date ~103, description ~149. Amounts are
// right-aligned and end near 546, so a normal figure starts around 510–530.
const COL = {
  transMin: 95,
  descMin: 140,
  amountMin: 460,
} as const;

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function lineText(items: Line["items"]): string {
  return items.map((item) => item.str).join(" ");
}

/** "Statement Date 26 FEB 2026" supplies the year for "DD MON" transaction dates. */
function findStatementDate(pages: Line[][]): { year: number; month: number } | null {
  for (const lines of pages) {
    for (const { items } of lines) {
      const label = items.findIndex((item) => item.str === "Statement Date");
      const dated = label >= 0 ? items[label + 1] : undefined;
      const match = dated ? STMT_DATE_RE.exec(dated.str) : null;
      const month = match && MONTHS[match[2]];
      if (match && month) return { year: Number(match[3]), month };
    }
  }
  return null;
}

/**
 * "18 FEB" on a February 2026 statement is 18/02/2026. A month later than the
 * statement month belongs to the previous year (December rows on a statement
 * dated in January).
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

/** Rewards, payment-advice, and glossary pages have no transaction rows. */
function isTransactionPage(lines: Line[]): boolean {
  return lines.some(({ items }) => {
    const text = lineText(items);
    if (
      /Description of Transaction|PREVIOUS BALANCE|End of Transaction Details/.test(text)
    ) {
      return true;
    }
    const first = items[0];
    return Boolean(first && first.x < COL.transMin && isTransactionDate(first.str));
  });
}

function isSkippable(text: string): boolean {
  return (
    /PREVIOUS BALANCE/.test(text) ||
    /SUB TOTAL/.test(text) ||
    /TOTAL BALANCE/.test(text) ||
    /End of Transaction Details/.test(text) ||
    /Description of Transaction/.test(text) ||
    /WELCOME TO/.test(text) ||
    /^Page \d+ of/.test(text) ||
    /Please note that you are bound/.test(text) ||
    /United Overseas Bank Limited/.test(text) ||
    /Credit Card\(s\) Statement/.test(text)
  );
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
    if (!isTransactionPage(lines)) continue;
    for (const { items } of lines) {
      const text = lineText(items);
      if (isSkippable(text)) continue;

      const first = items[0];
      const postDate = first && first.x < COL.transMin ? TXN_DATE_RE.exec(first.str) : null;
      if (postDate && MONTHS[postDate[2]]) {
        if (!statement) {
          throw new Error(
            "UOB credit statement is missing a statement date, so transaction years cannot be determined.",
          );
        }
        flush();
        const transItem = items.find(
          (it) => it.x >= COL.transMin && it.x < COL.descMin && isTransactionDate(it.str),
        );
        const transDate = transItem ? TXN_DATE_RE.exec(transItem.str) : null;
        const dated = transDate ?? postDate;

        let amount = "";
        let transactionType: TransactionType = "debit";
        let description = "";
        for (const it of items) {
          if (isTransactionDate(it.str) && it.x < COL.descMin) continue;
          const amountMatch = AMOUNT_RE.exec(it.str);
          if (it.x >= COL.amountMin && amountMatch) {
            amount = amountMatch[1];
            if (amountMatch[3]) transactionType = "credit";
          } else if (it.x >= COL.amountMin && /^CR$/i.test(it.str)) {
            transactionType = "credit";
          } else if (it.x >= COL.descMin && it.x < COL.amountMin) {
            description += (description ? " " : "") + it.str;
          }
        }
        cur = {
          date: toStatementDate(dated[1], dated[2], statement),
          description,
          amount,
          transactionType,
        };
      } else if (cur && first && first.x >= COL.descMin && first.x < COL.amountMin) {
        for (const it of items) {
          if (it.x >= COL.descMin && it.x < COL.amountMin && !AMOUNT_RE.test(it.str)) {
            cur.description += (cur.description ? " " : "") + it.str;
          }
        }
      }
    }
  }
  flush();
  return txns.filter((txn) => txn.amount !== "");
}

export const uobCreditParser: StatementParser = {
  accountType: "uobCredit",
  detect(pageText: string) {
    return pageText.includes(UOB_MARKER) && pageText.includes(UOB_CREDIT_MARKER);
  },
  parse: parseLines,
};
