import { createPlaceholder } from '../config';
import tables from './data/language-examples.json';
import { normalizeLangKey, pythonTitle } from './langKey';

// Generated from src/prompts/examples/placeholder_examples.py by
// tests/standalone/dump_ts_fixtures.py; do not edit the JSON by hand.
const TRANSLATIONS = tables as Record<string, { with_tags: string; without_tags: string }>;
const DEFAULT_LANGUAGE = 'english';

export const TAG0 = createPlaceholder(0);
export const TAG1 = createPlaceholder(1);
export const TAG2 = createPlaceholder(2);

export function getExampleForPair(sourceLang: string, targetLang: string) {
  const source = TRANSLATIONS[normalizeLangKey(sourceLang)] ?? TRANSLATIONS[DEFAULT_LANGUAGE];
  const target = TRANSLATIONS[normalizeLangKey(targetLang)] ?? TRANSLATIONS[DEFAULT_LANGUAGE];
  return { source: source.with_tags, correct: target.with_tags, wrong: target.without_tags };
}

/** Placeholder preservation instructions with a language-specific example. */
export function buildPlaceholderSection(sourceLang: string, targetLang: string): string {
  const example = getExampleForPair(sourceLang, targetLang);
  return `# PLACEHOLDER PRESERVATION (CRITICAL)

You will encounter placeholders like: ${TAG0}, ${TAG1}, ${TAG2}
These represent HTML/XML tags that have been temporarily replaced.

**UNIFIED FORMAT:**
All placeholders use the [idN] format: [id0], [id1], [id2]...
This semantic format provides the highest accuracy for preservation.

**MANDATORY RULES:**
1. Keep ALL placeholders EXACTLY as they appear
2. Do NOT translate, modify, remove, or explain them
3. Maintain their EXACT position in the sentence structure
4. Do NOT add spaces around them unless present in the source

**Example (${pythonTitle(sourceLang)} → ${pythonTitle(targetLang)}):**

Source: "${example.source}"
✅ Correct: "${example.correct}"
❌ WRONG: "${example.wrong}" (placeholders removed)
`;
}
