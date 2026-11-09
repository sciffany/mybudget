import type { AccountType, TransactionType } from "@/lib/db";

/** One transaction row, independent of which bank produced the statement. */
export interface StatementTransaction {
  date: string; // DD/MM/YYYY
  description: string;
  amount: string; // formatted amount, e.g. "1,234.56" (always non-negative)
  transactionType: TransactionType; // "debit" (money out) | "credit" (money in)
}

export interface ParsedStatement {
  accountType: AccountType;
  pageCount: number;
  transactions: StatementTransaction[];
}

export type Positioned = { x: number; str: string };
export type Line = { y: number; items: Positioned[] };

/** A page's visual lines plus the raw text used for account-type detection. */
export interface ExtractedPage {
  lines: Line[];
  /** Text items concatenated with no added separators, so split markers still match. */
  text: string;
}

/**
 * One statement format. `detect` decides ownership from page text; `parse`
 * turns the already-extracted lines into transactions.
 */
export interface StatementParser {
  accountType: AccountType;
  detect(pageText: string): boolean;
  parse(pages: Line[][]): StatementTransaction[];
}
