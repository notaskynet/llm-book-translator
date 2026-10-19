// Port of src/core/glossary/filter.py: the glossary entries that actually appear in a chunk.
// Latin terms match on word boundaries ("Fan" is not "Fantasy"); CJK terms match as substrings.
// A source may list inflected forms separated by '|'; any of them matches.

import { DEFAULT_GLOSSARY_CONFIG, type GlossaryConfig } from './models';

const cp = (n: number) => String.fromCodePoint(n);
const range = (a: number, b: number) => `${cp(a)}-${cp(b)}`;
// Hiragana, Katakana, CJK ideographs, Hangul syllables, CJK extension A.
const CJK = new RegExp(`[${range(0x3040, 0x309f)}${range(0x30a0, 0x30ff)}${range(0x4e00, 0x9fff)}${range(0xac00, 0xd7af)}${range(0x3400, 0x4dbf)}]`);
const WORD_CHAR = /[\p{L}\p{N}_]/u; // Python's \w

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function splitAlternatives(source: string): string[] {
  if (!source.includes('|')) {
    const stripped = source.trim();
    return stripped ? [stripped] : [];
  }
  return source.split('|').map((a) => a.trim()).filter(Boolean);
}

const maxAltLength = (source: string) => Math.max(0, ...splitAlternatives(source).map((a) => a.length));

function hasWordCharAtEdge(term: string): boolean {
  if (!term) return false;
  const chars = [...term];
  return WORD_CHAR.test(chars[0]) || WORD_CHAR.test(chars[chars.length - 1]);
}

function countAlternative(alt: string, chunk: string, haystack: string, caseSensitive: boolean): number {
  if (CJK.test(alt) || !hasWordCharAtEdge(alt)) {
    const needle = caseSensitive ? alt : alt.toLowerCase();
    return needle ? haystack.split(needle).length - 1 : 0;
  }
  // \b is ASCII-only in JS, so spell out the boundary with Unicode-aware lookarounds.
  const pattern = new RegExp(`(?<![\\p{L}\\p{N}_])${escapeRegExp(alt)}(?![\\p{L}\\p{N}_])`, caseSensitive ? 'gu' : 'giu');
  return (chunk.match(pattern) ?? []).length;
}

/** Entries present in `chunk`, longest source first; `capped` when `maxEntries` was exceeded. */
export function filterGlossary(
  chunk: string,
  terms: Map<string, string>,
  config: GlossaryConfig = DEFAULT_GLOSSARY_CONFIG,
): { terms: Map<string, string>; capped: boolean } {
  if (!chunk || !terms.size) return { terms: new Map(), capped: false };

  const haystack = config.caseSensitive ? chunk : chunk.toLowerCase();
  // Longest first, so "Li Fanqing" is checked before its prefix "Li Fan".
  const sorted = [...terms].sort((a, b) => maxAltLength(b[0]) - maxAltLength(a[0]));

  let matched: Array<[string, string, number]> = [];
  for (const [source, target] of sorted) {
    const alternatives = splitAlternatives(source);
    if (!alternatives.length) continue;
    const count = alternatives.reduce((n, alt) => n + countAlternative(alt, chunk, haystack, config.caseSensitive), 0);
    if (count > 0) matched.push([source, target, count]);
  }

  let capped = false;
  if (config.maxEntries && matched.length > config.maxEntries) {
    capped = true;
    // Keep the most frequent terms (length breaks ties), then restore the length-desc order.
    const kept = new Set(
      [...matched]
        .sort((a, b) => b[2] - a[2] || maxAltLength(b[0]) - maxAltLength(a[0]))
        .slice(0, config.maxEntries)
        .map(([s]) => s),
    );
    matched = matched.filter(([s]) => kept.has(s));
  }
  return { terms: new Map(matched.map(([s, t]) => [s, t])), capped };
}
