// Shared pdf.js text extraction. Parsers receive positioned lines and never
// open the PDF themselves, so detection and parsing share one read.

import type { TextItem, TextContent } from "pdfjs-dist/types/src/display/api";
import type { ExtractedPage, Line } from "@/lib/statements/types";

// Keep the worker version in lockstep with the installed `pdfjs-dist`.
const PDFJS_VERSION = "4.10.38";
const WORKER_SRC = `https://cdn.jsdelivr.net/npm/pdfjs-dist@${PDFJS_VERSION}/build/pdf.worker.min.mjs`;

// pdf.js often emits one printed token ("24/08", "591.42", "TRIP.COM") as
// several glyphs. Pieces of the same token nearly touch; a real word space is
// wider than this, so joining them does not glue neighbouring columns.
const GLYPH_GAP = 1.25;

type Glyph = { x: number; end: number; str: string };

/** Group a page's text items into visual lines, top-to-bottom, left-to-right. */
function toLines(items: TextItem[]): Line[] {
  const buckets: { y: number; items: Glyph[] }[] = [];
  for (const it of items) {
    const str = it.str.trim();
    if (!str) continue;
    const x = it.transform[4];
    const y = it.transform[5];
    const glyph = { x, end: x + (it.width || 0), str };
    const line = buckets.find((b) => Math.abs(b.y - y) <= 3);
    if (line) line.items.push(glyph);
    else buckets.push({ y, items: [glyph] });
  }
  buckets.sort((a, b) => b.y - a.y); // y descending = top of page first
  return buckets.map((bucket) => {
    const sorted = bucket.items.sort((a, c) => a.x - c.x);
    const merged: Glyph[] = [];
    for (const glyph of sorted) {
      const prev = merged[merged.length - 1];
      if (prev && glyph.x - prev.end <= GLYPH_GAP) {
        prev.str += glyph.str;
        prev.end = Math.max(prev.end, glyph.end);
      } else {
        merged.push({ ...glyph });
      }
    }
    return { y: bucket.y, items: merged.map(({ x, str }) => ({ x, str })) };
  });
}

/** Load a PDF and return each page's lines and raw text. */
export async function extractPdfPages(
  bytes: Uint8Array,
  onStatus?: (msg: string) => void,
): Promise<ExtractedPage[]> {
  onStatus?.("Loading PDF engine...");
  const pdfjs = await import("pdfjs-dist");
  pdfjs.GlobalWorkerOptions.workerSrc = WORKER_SRC;

  onStatus?.("Reading pages...");
  const doc = await pdfjs.getDocument({ data: bytes }).promise;
  const pages: ExtractedPage[] = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const content: TextContent = await page.getTextContent();
    const items = content.items as TextItem[];
    pages.push({
      lines: toLines(items),
      text: items.map((it) => it.str).join(""),
    });
  }
  return pages;
}
