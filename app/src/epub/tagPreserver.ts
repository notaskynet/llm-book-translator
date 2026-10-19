// Port of src/core/epub/tag_preservation.py (the placeholder path; technical-content
// protection is disabled in the Python pipeline and is not ported).

import { createPlaceholder, parsePlaceholder } from './placeholders';

// Whitespace, numbers and roman numerals carry nothing to translate. `i` makes the roman
// numerals case-insensitive, as in the original.
const NON_TRANSLATABLE = /^[\p{Nd}.\-–—)(\s\u00A0\u2000-\u200F\u2028\u2029IVXLCDM]+$/iu;

export function isNonTranslatable(text: string): boolean {
  if (!text) return true;
  const stripped = text.trim();
  if (!stripped) return true;
  return NON_TRANSLATABLE.test(stripped);
}

export interface PreservedTags {
  text: string;
  tagMap: Record<string, string>;
}

/**
 * Replaces HTML tags with `[idN]` placeholders, merging adjacent tags and
 * non-translatable content (whitespace, numbers) into a single placeholder.
 */
export function preserveTags(text: string): PreservedTags {
  const tagMap: Record<string, string> = {};
  let counter = 0;
  const out: string[] = [];
  let group: string[] = [];

  const flush = () => {
    if (!group.length) return;
    const placeholder = createPlaceholder(counter++);
    tagMap[placeholder] = group.join('');
    out.push(placeholder);
    group = [];
  };

  for (const segment of text.split(/(<[^>]+>)/)) {
    if (!segment) continue;
    const isTag = segment.startsWith('<') && segment.endsWith('>');
    if (isTag || isNonTranslatable(segment)) {
      group.push(segment);
    } else {
      flush();
      out.push(segment);
    }
  }
  flush();
  return { text: out.join(''), tagMap };
}

/** Puts the original tags back. Highest numbers first so `[id10]` is not clobbered by `[id1]`. */
export function restoreTags(text: string, tagMap: Record<string, string>): string {
  let restored = text;
  const placeholders = Object.keys(tagMap).sort((a, b) => (parsePlaceholder(b) ?? 0) - (parsePlaceholder(a) ?? 0));
  for (const placeholder of placeholders) {
    if (restored.includes(placeholder)) restored = restored.split(placeholder).join(tagMap[placeholder]);
  }
  return restored;
}
