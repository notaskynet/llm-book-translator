// PDF input: the text layer is extracted with pdf.js and rebuilt into paragraphs, then handled
// like a plain text file. A PDF carries no reflowable structure, so the layout is not kept and
// scanned documents (no text layer) yield nothing.

interface Line {
  text: string;
  y: number;
}

interface TextItem {
  str: string;
  transform: number[];
  height: number;
  hasEOL?: boolean;
}

const TERMINAL = /[.!?…:;"'”’»)\]]$/;
/** A low percentile: paragraph breaks are the large gaps, so they must not drag the estimate up. */
const typicalGap = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? sorted[Math.floor(sorted.length * 0.35)] : 0;
};

/** Groups a page's text items into visual lines, top to bottom. */
function pageLines(items: TextItem[]): Line[] {
  const lines: Line[] = [];
  let current: { parts: string[]; y: number; height: number } | null = null;
  const flush = () => {
    if (current) lines.push({ text: current.parts.join('').replace(/\s+/g, ' ').trim(), y: current.y });
    current = null;
  };
  for (const item of items) {
    const y = item.transform[5];
    if (current && Math.abs(y - current.y) > Math.max(1, current.height * 0.5) && item.str.trim()) flush();
    if (!current) current = { parts: [], y, height: item.height || 10 };
    current.parts.push(item.str);
    if (item.hasEOL) flush();
  }
  flush();
  return lines.filter((l) => l.text);
}

const lineGaps = (lines: Line[]) => lines.slice(1).map((l, i) => lines[i].y - l.y).filter((g) => g > 0);

/** Joins a page's lines into paragraphs: a line gap well above the usual leading starts a new one. */
function pageParagraphs(lines: Line[], normal: number): string[] {
  const paragraphs: string[] = [];
  let current = '';
  lines.forEach((line, i) => {
    const gap = i > 0 ? lines[i - 1].y - line.y : 0;
    if (!current) { current = line.text; return; }
    if (normal > 0 && gap > normal * 1.4) {
      paragraphs.push(current);
      current = line.text;
    } else if (/\p{L}-$/u.test(current) && /^\p{Ll}/u.test(line.text)) {
      current = current.slice(0, -1) + line.text; // hyphenated at the line end
    } else {
      current += ` ${line.text}`;
    }
  });
  if (current) paragraphs.push(current);
  return paragraphs;
}

async function loadPdfjs() {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  if (!pdfjs.GlobalWorkerOptions.workerSrc && !(globalThis as { pdfjsWorker?: unknown }).pdfjsWorker) {
    pdfjs.GlobalWorkerOptions.workerSrc = (await import('pdfjs-dist/legacy/build/pdf.worker.min.mjs?url')).default;
  }
  return pdfjs;
}

/** The PDF's text as blank-line-separated paragraphs; empty when it has no text layer. */
export async function extractPdfText(data: ArrayBuffer | Uint8Array): Promise<string> {
  const pdfjs = await loadPdfjs();
  const task = pdfjs.getDocument({ data: new Uint8Array(data).slice() });
  const doc = await task.promise;
  try {
    const pages: Line[][] = [];
    for (let n = 1; n <= doc.numPages; n++) {
      const content = await (await doc.getPage(n)).getTextContent();
      pages.push(pageLines(content.items.filter((i) => 'str' in i) as unknown as TextItem[]));
    }
    // The leading is a property of the document, so short pages borrow it from the rest.
    const normal = typicalGap(pages.flatMap(lineGaps));

    const paragraphs: string[] = [];
    for (const lines of pages) {
      const found = pageParagraphs(lines, normal);
      // A paragraph that runs over the page break carries on in lower case.
      if (paragraphs.length && found.length && !TERMINAL.test(paragraphs[paragraphs.length - 1]) && /^\p{Ll}/u.test(found[0])) {
        paragraphs[paragraphs.length - 1] += ` ${found.shift()}`;
      }
      paragraphs.push(...found);
    }
    return paragraphs.join('\n\n');
  } finally {
    await task.destroy();
  }
}
