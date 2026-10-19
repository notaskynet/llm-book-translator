// Port of src/core/post_processor.py: the default cleanup applied to refined text.
//
// Known upstream behaviour kept for parity: removing the space before `. , ! ? ; :` damages
// languages that put one there (French: "Quoi ?"). It only runs on the plain-text refine path.

const ENTITY_REPLACEMENTS: Array<[string, string]> = [
  ['&amp;', '&'], ['&lt;', '<'], ['&gt;', '>'], ['&quot;', '"'], ['&#39;', "'"], ['&apos;', "'"],
  ['&mdash;', '—'], ['&ndash;', '–'], ['&hellip;', '…'],
];

function cleanHtmlEntities(text: string): string {
  // Runs of &nbsp; become that many real non-breaking spaces.
  let out = text.replace(/(&nbsp;)+/g, (m) => ' '.repeat(m.length / 6));
  for (const [entity, replacement] of ENTITY_REPLACEMENTS) out = out.split(entity).join(replacement);
  return out;
}

function removeExtraWhitespace(text: string): string {
  return text
    .replace(/ +/g, ' ')
    .replace(/ +([.,!?;:])/g, '$1')
    .replace(/\n\s*\n\s*\n/g, '\n\n')
    .trim();
}

export function cleanTranslatedText(text: string): string {
  if (!text) return text;
  return removeExtraWhitespace(cleanHtmlEntities(text));
}
