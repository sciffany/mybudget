// OCBC credit-card statement parser (Infinity Cashback and the same layout).
//
// Each purchase is a transaction date (DD/MM), a description, and a
// right-aligned SGD amount. Payments and refunds are wrapped in parentheses
// or carry a CR marker and are money in (credit); other amounts are card
// charges (debit). Summary rows
// (last month's balance, subtotal, total, total amount due) and the payment
// slip are not transactions.

import type { TransactionType } from "@/lib/db";
import type { Line, StatementParser, StatementTransaction } from "@/lib/statements/types";

/** Footer company name printed on every OCBC statement page. */
const OCBC_MARKER = "Oversea-Chinese Banking Corporation";

const TXN_DATE_RE = /^(\d{2})\/(\d{2})$/;
const AMOUNT_RE = /^(\()?(\d{1,3}(?:,\d{3})*\.\d{2})(\))?(?:\s*(CR))?$/i;
const CARD_RE = /^\d{4}-\d{4}-\d{4}-\d{4}$/;

/** Parentheses or a CR suffix mark a payment or refund (money in). */
function parseAmount(str: string): { amount: string; credit: boolean } | null {
  const match = AMOUNT_RE.exec(str);
  if (!match) return null;
  return { amount: match[2], credit: Boolean(match[1] || match[3] || match[4]) };
}

// Start-x gaps measured from an Infinity Cashback statement (A4, ~595pt).
// Transaction date ~58, description ~199. Amounts are right-aligned and end
// near 545, so a normal figure starts around 500–530.
const COL = {
  descMin: 170,
  amountMin: 460,
} as const;

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function lineText(items: Line["items"]): string {
  return items.map((item) => item.str).join(" ");
}

function parseTxnDate(str: string): { day: string; month: number } | null {
  const match = TXN_DATE_RE.exec(str);
  if (!match) return null;
  const day = Number(match[1]);
  const month = Number(match[2]);
  if (day < 1 || day > 31 || month < 1 || month > 12) return null;
  return { day: match[1], month };
}

const STMT_DATE_RE = /^(\d{2})-(\d{2})-(\d{4})$/;

/**
 * The statement date is printed under the "STATEMENT DATE" label, as
 * "18-09-2026". It supplies the year for "DD/MM" transaction dates.
 */
function findStatementDate(pages: Line[][]): { year: number; month: number } | null {
  for (const lines of pages) {
    for (let i = 0; i < lines.length; i++) {
      const label = lines[i].items.find((item) => item.str === "STATEMENT DATE");
      if (!label) continue;
      for (const line of lines.slice(i, i + 3)) {
        const dated = line.items.find(
          (item) => Math.abs(item.x - label.x) <= 40 && STMT_DATE_RE.test(item.str),
        );
        const match = dated ? STMT_DATE_RE.exec(dated.str) : null;
        if (!match) continue;
        const month = Number(match[2]);
        if (month < 1 || month > 12) continue;
        return { year: Number(match[3]), month };
      }
    }
  }
  return null;
}

/**
 * "24/08" on a statement dated 18-09-2026 is 24/08/2026. A month later than
 * the statement month belongs to the previous year (December rows on a
 * statement dated in January).
 */
function toStatementDate(
  day: string,
  month: number,
  statement: { year: number; month: number },
): string {
  const year = month > statement.month ? statement.year - 1 : statement.year;
  return `${day}/${pad2(month)}/${year}`;
}

/** Transaction rows live under the "TRANSACTION DATE" header, not the slip. */
function isTransactionPage(lines: Line[]): boolean {
  return lines.some(({ items }) => {
    if (/TRANSACTION DATE/.test(lineText(items))) return true;
    return items.some((item) => item.x < COL.descMin && parseTxnDate(item.str));
  });
}

function isSkippable(text: string): boolean {
  const trimmed = text.trim();
  return (
    /LAST MONTH'?S BALANCE/.test(trimmed) ||
    /^(SUBTOTAL|TOTAL AMOUNT DUE|TOTAL)\b/.test(trimmed) ||
    /TRANSACTION DATE/.test(trimmed) ||
    /STATEMENT DATE/.test(trimmed) ||
    /AMOUNT \(SGD\)/.test(trimmed) ||
    /Oversea-Chinese/.test(trimmed) ||
    /intentionally left blank/.test(trimmed) ||
    /^Page \d+ of/.test(trimmed)
  );
}

function isCardHeader(items: Line["items"]): boolean {
  return items.some((item) => CARD_RE.test(item.str));
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
      if (isSkippable(text) || isCardHeader(items)) continue;

      const dated = items.find((item) => item.x < COL.descMin && parseTxnDate(item.str));
      const date = dated ? parseTxnDate(dated.str) : null;
      if (date) {
        if (!statement) {
          throw new Error(
            "OCBC credit statement is missing a statement date, so transaction years cannot be determined.",
          );
        }
        flush();
        let amount = "";
        let transactionType: TransactionType = "debit";
        let description = "";
        for (const it of items) {
          if (it === dated) continue;
          const amountMatch = parseAmount(it.str);
          if (it.x >= COL.amountMin && amountMatch) {
            amount = amountMatch.amount;
            if (amountMatch.credit) transactionType = "credit";
          } else if (it.x >= COL.amountMin && /^CR$/i.test(it.str)) {
            transactionType = "credit";
          } else if (it.x >= COL.descMin && it.x < COL.amountMin) {
            description += (description ? " " : "") + it.str;
          }
        }
        cur = {
          date: toStatementDate(date.day, date.month, statement),
          description,
          amount,
          transactionType,
        };
      } else if (cur) {
        for (const it of items) {
          const amountMatch = parseAmount(it.str);
          if (it.x >= COL.amountMin && amountMatch && !cur.amount) {
            cur.amount = amountMatch.amount;
            if (amountMatch.credit) cur.transactionType = "credit";
          } else if (it.x >= COL.amountMin && /^CR$/i.test(it.str)) {
            cur.transactionType = "credit";
          } else if (
            it.x >= COL.descMin &&
            it.x < COL.amountMin &&
            !parseAmount(it.str)
          ) {
            cur.description += (cur.description ? " " : "") + it.str;
          }
        }
      }
    }
  }
  flush();
  return txns.filter((txn) => txn.amount !== "");
}

export const ocbcCreditParser: StatementParser = {
  accountType: "ocbcCredit",
  detect(pageText: string) {
    return (
      pageText.includes(OCBC_MARKER) &&
      pageText.includes("TRANSACTION DATE") &&
      pageText.includes("AMOUNT (SGD)") &&
      pageText.includes("TOTAL AMOUNT DUE")
    );
  },
  parse: parseLines,
};
