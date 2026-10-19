// Port of the bilingual interleaving in xhtml_translator.py: each source paragraph is
// followed by its translation. Works on the FULL source and FULL translation (a chapter is
// usually wrapped in a container spanning many chunks, so per-chunk fragments are unbalanced).

import { XHTML_NS, localName, parseXml } from './dom';

export const BILINGUAL_ORIGINAL_STYLE = 'color: #666; font-size: 0.9em;';
export const BILINGUAL_TRANSLATION_STYLE = 'margin-bottom: 1em; padding-bottom: 0.5em; border-bottom: 1px dashed #ccc;';

const CONTAINER_TAGS = new Set([
  'body', 'div', 'section', 'article', 'aside', 'nav', 'header', 'footer', 'main', 'blockquote',
  'ul', 'ol', 'li', 'dl', 'dd', 'dt', 'table', 'tbody', 'thead', 'tfoot', 'tr', 'td', 'th',
  'figure', 'figcaption',
]);

const elementChildren = (el: Element) => Array.from(el.children);
const hasTranslatableText = (el: Element) => (el.textContent ?? '').trim() !== '';

/** Only the container skeleton must match; leaf paragraphs may differ inside. */
function sameStructure(orig: Element, trans: Element): boolean {
  if (CONTAINER_TAGS.has(localName(orig))) {
    const oc = elementChildren(orig);
    const tc = elementChildren(trans);
    if (oc.length !== tc.length) return false;
    return oc.every((o, i) => sameStructure(o, tc[i]));
  }
  return true;
}

function makeDiv(doc: Document, className: string, style: string): HTMLElement {
  const div = doc.createElementNS(XHTML_NS, 'div') as HTMLElement;
  div.setAttribute('class', className);
  div.setAttribute('style', style);
  return div;
}

function merge(orig: Element, trans: Element, outParent: Element): void {
  const doc = outParent.ownerDocument;
  if (CONTAINER_TAGS.has(localName(orig))) {
    const copy = orig.cloneNode(false) as Element; // keeps tag and attributes, drops children
    outParent.appendChild(copy);
    if (orig.firstChild?.nodeType === Node.TEXT_NODE) copy.appendChild(doc.createTextNode(orig.firstChild.textContent ?? ''));
    const pairs = elementChildren(orig).map((o, i) => [o, elementChildren(trans)[i]] as const);
    for (const [oc, tc] of pairs) {
      const before = copy.childNodes.length;
      merge(oc, tc, copy);
      // Preserve inter-element whitespace from the source.
      const tail = oc.nextSibling;
      if (copy.childNodes.length > before && tail?.nodeType === Node.TEXT_NODE) {
        copy.appendChild(doc.createTextNode(tail.textContent ?? ''));
      }
    }
    return;
  }

  if (hasTranslatableText(orig)) {
    const od = makeDiv(doc, 'bilingual-original', BILINGUAL_ORIGINAL_STYLE);
    od.appendChild(orig.cloneNode(true));
    outParent.appendChild(od);
    const td = makeDiv(doc, 'bilingual-translation', BILINGUAL_TRANSLATION_STYLE);
    td.appendChild(trans.cloneNode(true));
    outParent.appendChild(td);
  } else {
    outParent.appendChild(orig.cloneNode(true)); // blank/separator block: keep once
  }
}

/** Returns the interleaved inner HTML, or null when the two structures do not align. */
export function interleaveBilingual(origHtml: string, transHtml: string): string | null {
  const wrap = (html: string) => parseXml(`<temp xmlns="${XHTML_NS}">${html}</temp>`, 'application/xhtml+xml');
  const oDoc = wrap(origHtml);
  const tDoc = wrap(transHtml);
  if (!oDoc?.documentElement || !tDoc?.documentElement) return null;

  const oRoot = oDoc.documentElement;
  const oc = elementChildren(oRoot);
  const tc = elementChildren(tDoc.documentElement);
  if (oc.length !== tc.length || !oc.every((o, i) => sameStructure(o, tc[i]))) return null;

  try {
    const out = oDoc.createElementNS(XHTML_NS, 'temp');
    if (oRoot.firstChild?.nodeType === Node.TEXT_NODE) out.appendChild(oDoc.createTextNode(oRoot.firstChild.textContent ?? ''));
    oc.forEach((o, i) => {
      const before = out.childNodes.length;
      merge(o, tc[i], out);
      const tail = o.nextSibling;
      if (out.childNodes.length > before && tail?.nodeType === Node.TEXT_NODE) {
        out.appendChild(oDoc.createTextNode(tail.textContent ?? ''));
      }
    });
    // Serialize children one by one so the wrapper element does not leak into the output.
    const serializer = new XMLSerializer();
    return Array.from(out.childNodes)
      .map((n) => serializer.serializeToString(n).replace(` xmlns="${XHTML_NS}"`, ''))
      .join('');
  } catch {
    return null;
  }
}
