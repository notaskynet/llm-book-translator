// DOM helpers for XHTML documents. Python used lxml with `recover=True`; the browser's XML
// parser is strict, so every parse falls back to the lenient HTML parser.

import { normalizeWhitespace } from './xmlText';

export const XHTML_NS = 'http://www.w3.org/1999/xhtml';
export const XML_NS = 'http://www.w3.org/XML/1998/namespace';

const hasParseError = (doc: Document) => doc.getElementsByTagName('parsererror').length > 0;

export function parseXml(text: string, type: DOMParserSupportedType = 'application/xml'): Document | null {
  try {
    const doc = new DOMParser().parseFromString(text, type);
    return hasParseError(doc) ? null : doc;
  } catch {
    return null;
  }
}

/** Parses an XHTML file; malformed XML (e.g. undefined entities) falls back to the HTML parser. */
export function parseXhtmlDocument(text: string): Document | null {
  const xml = parseXml(text, 'application/xhtml+xml');
  if (xml?.documentElement) return xml;
  try {
    const html = new DOMParser().parseFromString(text, 'text/html');
    return html.documentElement ? html : null;
  } catch {
    return null;
  }
}

export function serializeDocument(doc: Document): string {
  const xml = new XMLSerializer().serializeToString(doc);
  return xml.startsWith('<?xml') ? xml : `<?xml version="1.0" encoding="utf-8"?>\n${xml}`;
}

export const localName = (node: Node): string => ((node as Element).localName ?? node.nodeName).toLowerCase();

export function findBody(doc: Document): Element | null {
  return doc.getElementsByTagNameNS(XHTML_NS, 'body')[0] ?? doc.getElementsByTagName('body')[0] ?? null;
}

/** The inner HTML of `<body>` as an XML string, whitespace-normalised. */
export function extractBodyHtml(body: Element): string {
  let xml = new XMLSerializer().serializeToString(body);
  if (/^<body[^>]*\/>$/.test(xml)) return '';
  xml = xml.replace(/^<body[^>]*>/, '').replace(/<\/body>$/, '').trim();
  return normalizeWhitespace(xml);
}

export class BodyReplacementError extends Error {}

/** Parses an HTML/XML fragment into nodes owned by `doc`. */
export function parseFragment(html: string, doc: Document): Node[] {
  const xml = parseXml(`<temp xmlns="${XHTML_NS}">${html}</temp>`, 'application/xhtml+xml');
  if (xml?.documentElement) return Array.from(xml.documentElement.childNodes).map((n) => doc.importNode(n, true));

  // Last resort: the lenient HTML parser (may alter structure, as in the original).
  const parsed = new DOMParser().parseFromString(`<!doctype html><body>${html}`, 'text/html');
  if (!parsed.body) throw new BodyReplacementError('Could not parse the translated HTML');
  return Array.from(parsed.body.childNodes).map((n) => doc.importNode(n, true));
}

/**
 * Replaces the content of `<body>`. INVARIANT: a populated body is never emptied; the new
 * content is parsed before anything is removed, so a parse failure leaves the body intact.
 */
export function replaceBodyContent(body: Element, html: string): void {
  if (html.trim() === '' && (body.childNodes.length > 0 && (body.textContent ?? '').trim() !== '' || body.children.length > 0)) {
    throw new BodyReplacementError('refusing to replace populated <body> with empty content');
  }
  const nodes = parseFragment(html, body.ownerDocument);
  while (body.firstChild) body.removeChild(body.firstChild);
  for (const node of nodes) body.appendChild(node);
}

/** Visible text of an element with whitespace collapsed, or null when empty. */
export function normalizedText(el: Node): string | null {
  const text = (el.textContent ?? '').split(/\s+/).filter(Boolean).join(' ');
  return text || null;
}

export function* iterElements(root: Element): Generator<Element> {
  yield root;
  for (const child of Array.from(root.getElementsByTagName('*'))) yield child;
}
