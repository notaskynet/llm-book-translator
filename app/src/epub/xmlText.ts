// Text-level helpers for putting translated text back into XHTML: stray-markup escaping
// (xhtml_translator.py) and whitespace normalisation (body_serializer.py).

const XML_PREDEFINED_ENTITIES = new Set(['amp', 'lt', 'gt', 'quot', 'apos']);

// '&' optionally followed by a well-formed reference body (numeric, or named, semicolon included).
const AMP_OR_ENTITY = /&(#(?:[0-9]+|[xX][0-9a-fA-F]+);|[a-zA-Z][a-zA-Z0-9]*;)?/g;

const isValidXmlCodepoint = (cp: number) =>
  cp === 0x9 || cp === 0xa || cp === 0xd || (cp >= 0x20 && cp <= 0xd7ff) || (cp >= 0xe000 && cp <= 0xfffd) || (cp >= 0x10000 && cp <= 0x10ffff);

let entityDecoder: HTMLTextAreaElement | undefined;

/** Decodes a named HTML entity ("&hellip;") through the browser's own table, or null if unknown. */
function decodeNamedEntity(ref: string): string | null {
  entityDecoder ??= document.createElement('textarea');
  entityDecoder.innerHTML = `&${ref}`;
  const value = entityDecoder.value;
  return value === `&${ref}` ? null : value;
}

/**
 * Neutralises every '&' the XML parser would not accept (issue #202): known HTML entities
 * (&nbsp;, &hellip;...) become their characters, anything else becomes '&amp;', so the text
 * renders verbatim instead of being dropped.
 */
export function escapeStrayAmpersands(text: string): string {
  return text.replace(AMP_OR_ENTITY, (match, ref: string | undefined) => {
    if (ref === undefined) return '&amp;';
    if (ref.startsWith('#')) {
      const cp = ref[1] === 'x' || ref[1] === 'X' ? Number.parseInt(ref.slice(2, -1), 16) : Number.parseInt(ref.slice(1, -1), 10);
      return Number.isFinite(cp) && isValidXmlCodepoint(cp) ? match : `&amp;${ref}`;
    }
    if (XML_PREDEFINED_ENTITIES.has(ref.slice(0, -1))) return match;
    const decoded = decodeNamedEntity(ref);
    if (decoded !== null) return decoded.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return `&amp;${ref}`;
  });
}

/** Escapes stray `&`, `<` and `>` so the reinjected body parses cleanly. */
export function escapeStrayAngleBrackets(text: string): string {
  return escapeStrayAmpersands(text).replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Collapses source-formatting whitespace inside text while keeping structural breaks:
 * newlines are injected after block closing tags, and `<pre>`/`<code>`/`<script>`/`<style>`
 * blocks and `<br>` tags are left untouched.
 */
export function normalizeWhitespace(html: string): string {
  const preserved: string[] = [];
  const keep = (match: string) => `__PRESERVED_BLOCK_${preserved.push(match) - 1}__`;

  let out = html.replace(/<(pre|code|script|style)[^>]*>[\s\S]*?<\/\1>/gi, keep);
  out = out.replace(/<br\s*\/?\s*>/gi, keep);

  out = out.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const blockTags = '</(?:p|div|li|h[1-6]|blockquote|section|article|header|footer|nav|aside|ol|ul|table|tr|td|th|dt|dd)>';
  out = out.replace(new RegExp(`(${blockTags})[ \\t]*`, 'gi'), '$1\n');
  out = out.replace(/(?<!>)[ \t]*\n(?!\n)[ \t]*/g, ' ');
  out = out.replace(/ {2,}/g, ' ');
  out = out.replace(/ \n/g, '\n');
  out = out.replace(/\n /g, '\n');

  preserved.forEach((block, i) => {
    out = out.split(`__PRESERVED_BLOCK_${i}__`).join(block);
  });
  return out;
}

/** Removes `[idN]` placeholders left over after tag restoration. */
export function cleanResidualPlaceholders(text: string): string {
  return text.replace(/\[id(\d+)\]/g, '');
}
