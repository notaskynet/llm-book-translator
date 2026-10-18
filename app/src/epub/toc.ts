// Port of the TOC label updates in src/core/epub/translator.py: reader side panels build
// their table of contents from the NCX (EPUB2) and nav document (EPUB3), which the body
// translation never touches. Labels are copied from the translated headings; `href`/`src`
// are never modified.

import { iterElements, localName, normalizedText } from './dom';
import { joinPath, unquote } from './zipUtils';

export interface TocStats {
  updated: number;
  unchanged: number;
}

const HEADINGS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6']);
export const NCX_NS = 'http://www.daisy.org/z3986/2005/ncx/';
export const EPUB_NS = 'http://www.idpf.org/2007/ops';

function findByIdOrName(doc: Document, fragment: string): Element | null {
  for (const el of iterElements(doc.documentElement)) {
    if (el.getAttribute('id') === fragment || el.getAttribute('name') === fragment) return el;
  }
  return null;
}

function headingNear(anchor: Element): string | null {
  for (let cur: Element | null = anchor; cur; cur = cur.parentElement) {
    if (HEADINGS.has(localName(cur))) return normalizedText(cur);
  }
  return normalizedText(anchor);
}

function firstHeading(doc: Document): string | null {
  for (const el of iterElements(doc.documentElement)) {
    if (HEADINGS.has(localName(el))) {
      const title = normalizedText(el);
      if (title) return title;
    }
  }
  return null;
}

/** Heading text of the translated document a TOC link points at. */
export function translatedTitleForSrc(src: string, baseDir: string, docsByPath: Map<string, Document>): string | null {
  const [rawHref, ...rest] = src.split('#');
  const fragment = rest.length ? unquote(rest.join('#')) : '';
  const href = unquote(rawHref);
  if (!href) return null;

  const doc = docsByPath.get(joinPath(baseDir, href));
  if (!doc) return null;
  if (fragment) {
    const anchor = findByIdOrName(doc, fragment);
    const title = anchor && headingNear(anchor);
    if (title) return title;
  }
  return firstHeading(doc);
}

/** Updates `navPoint/navLabel/text` of an NCX document in place. */
export function updateNcxLabels(ncx: Document, ncxDir: string, docsByPath: Map<string, Document>): TocStats {
  const stats: TocStats = { updated: 0, unchanged: 0 };
  for (const navPoint of Array.from(ncx.getElementsByTagNameNS(NCX_NS, 'navPoint'))) {
    const label = navPoint.getElementsByTagNameNS(NCX_NS, 'navLabel')[0]?.getElementsByTagNameNS(NCX_NS, 'text')[0];
    const content = Array.from(navPoint.children).find((c) => localName(c) === 'content');
    const src = content?.getAttribute('src');
    const title = src ? translatedTitleForSrc(src, ncxDir, docsByPath) : null;
    if (!label || !title || label.textContent === title) {
      stats.unchanged++;
    } else {
      label.textContent = title;
      stats.updated++;
    }
  }
  return stats;
}

/** Updates the link labels of the EPUB3 TOC `<nav>` (landmarks and page-list are skipped). */
export function updateNavLabels(nav: Document, navDir: string, docsByPath: Map<string, Document>): TocStats {
  const stats: TocStats = { updated: 0, unchanged: 0 };
  for (const navEl of iterElementsByName(nav, 'nav')) {
    const type = (navEl.getAttributeNS(EPUB_NS, 'type') ?? navEl.getAttribute('epub:type') ?? '').trim();
    if (type === 'landmarks' || type === 'page-list') continue;

    for (const anchor of Array.from(navEl.getElementsByTagName('*')).filter((e) => localName(e) === 'a')) {
      const src = anchor.getAttribute('href');
      const title = src ? translatedTitleForSrc(src, navDir, docsByPath) : null;
      if (!title || normalizedText(anchor) === title) {
        stats.unchanged++;
        continue;
      }
      while (anchor.firstChild) anchor.removeChild(anchor.firstChild); // TOC links may carry inline markup
      anchor.textContent = title;
      stats.updated++;
    }
  }
  return stats;
}

function iterElementsByName(doc: Document, name: string): Element[] {
  return Array.from(doc.getElementsByTagName('*')).filter((e) => localName(e) === name);
}
