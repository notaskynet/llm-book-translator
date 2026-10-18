// Port of src/core/style/lint.py: a conservative check that a style rule stays abstract. A false
// positive costs the reviewer one click; a false negative bakes a language tic into every chunk.

import { ALLOWED_DIMENSIONS } from './dimensions';

const TOO_SPECIFIC_MIN_CHARS = 25;

const QUOTE_PATTERNS = [/"[^"]*[A-Za-z][^"]*"/, /'[^']*[A-Za-z][^']*'/, /«[^»]*[A-Za-z][^»]*»/, /“[^”]*[A-Za-z][^”]*”/, /‘[^’]*[A-Za-z][^’]*’/];
const EXAMPLE_MARKER = /\b(e\.g\.|i\.e\.|for example|such as|for instance|words like|expressions like|terms like|phrases like)\b/i;
const CLAUSE_SPLIT = /[.;:!?]+/;
const SENTENCE_SPLIT = /(?<=[.!?])\s+/;
const WORD = /[A-Za-z][A-Za-z'-]*/g;

const LANGUAGE_NAMES = [
  'english', 'french', 'spanish', 'german', 'italian', 'portuguese', 'chinese', 'japanese', 'korean', 'russian',
  'dutch', 'arabic', 'polish', 'turkish', 'vietnamese', 'swedish', 'norwegian', 'danish', 'finnish', 'greek',
  'hebrew', 'hindi', 'thai', 'indonesian', 'ukrainian', 'czech', 'romanian', 'hungarian', 'mandarin', 'cantonese',
];
const EXEMPT_WORDS = new Set([...LANGUAGE_NAMES, ...ALLOWED_DIMENSIONS.flatMap((d) => d.split('_'))]);

const words = (text: string) => text.match(WORD) ?? [];

/** A comma/slash-separated run of 3+ items where every item is 1-2 tokens long. */
function hasWordList(text: string): boolean {
  for (const clause of text.split(CLAUSE_SPLIT)) {
    const items = clause.split(/[,/]/).map((i) => i.trim()).filter(Boolean);
    if (items.length < 3) continue;
    let run = 0;
    for (const item of items) {
      const n = words(item).length;
      if (n >= 1 && n <= 2) {
        if (++run >= 3) return true;
      } else {
        run = 0;
      }
    }
  }
  return false;
}

/** A run of 2+ capitalised tokens that are not at a sentence start, or any all-caps/CamelCase token. */
function hasProperNoun(text: string, exempt: Set<string>): boolean {
  for (const sentence of text.split(SENTENCE_SPLIT)) {
    let run = 0;
    const tokens = words(sentence);
    for (let index = 0; index < tokens.length; index++) {
      const token = tokens[index];
      if (exempt.has(token.toLowerCase())) { run = 0; continue; }
      const isAllCaps = token === token.toUpperCase() && token !== token.toLowerCase() && token.length >= 2;
      if (isAllCaps || /[a-z][A-Z]/.test(token)) return true;
      if (/[A-Z]/.test(token[0]) && index !== 0) {
        if (++run >= 2) return true;
      } else {
        run = 0;
      }
    }
  }
  return false;
}

/** Violation codes found in `text`, in a fixed order. Pure function. */
export function lintInstruction(text: string, extraExempt: Iterable<string> = []): string[] {
  if (!text) return [];
  const exempt = new Set([...EXEMPT_WORDS, ...[...extraExempt].map((w) => w.toLowerCase())]);
  const flags: string[] = [];
  if (QUOTE_PATTERNS.some((p) => p.test(text))) flags.push('quoted_example');
  if (EXAMPLE_MARKER.test(text)) flags.push('example_marker');
  if (hasWordList(text)) flags.push('word_list');
  if (hasProperNoun(text, exempt)) flags.push('proper_noun');
  if (text.trim().length < TOO_SPECIFIC_MIN_CHARS) flags.push('too_specific');
  return flags;
}
