// Statement import entry point.
//
// Add a new account type by implementing StatementParser and appending it to
// `parsers`. The first parser whose `detect` matches the page text is used.

import type { AccountType } from "@/lib/db";
import { dbsParser } from "@/lib/statements/dbs";
import { ocbcParser } from "@/lib/statements/ocbc";
import { paylahParser } from "@/lib/statements/paylah";
import { extractPdfPages } from "@/lib/statements/pdf";
import type { ParsedStatement, StatementParser } from "@/lib/statements/types";

const parsers: StatementParser[] = [paylahParser, ocbcParser, dbsParser];

export async function parseStatement(
  bytes: Uint8Array,
  onStatus?: (msg: string) => void,
): Promise<ParsedStatement> {
  const pages = await extractPdfPages(bytes, onStatus);
  const pageText = pages.map((page) => page.text).join("");

  onStatus?.("Detecting account type...");
  const parser = parsers.find((candidate) => candidate.detect(pageText));
  if (!parser) {
    throw new Error(
      "Unrecognized statement. None of the supported account types matched this PDF.",
    );
  }

  onStatus?.("Extracting transactions...");
  return {
    accountType: parser.accountType,
    pageCount: pages.length,
    transactions: parser.parse(pages.map((page) => page.lines)),
  };
}

export function supportedAccountTypes(): AccountType[] {
  return parsers.map((parser) => parser.accountType);
}

export type { ParsedStatement, StatementParser, StatementTransaction } from "@/lib/statements/types";
