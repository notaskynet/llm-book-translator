// Port of src/core/glossary/injector.py: the prompt blocks built from a glossary.

import { targetLanguageIsInflected } from './inflection';
import { DEFAULT_MAX_CAST_ENTRIES, normalizeGender, type TermMetadata } from './models';

// Target-side counterpart of the '|' source-variants line: in an inflected target language the
// listed citation form is rarely the form a grammatical sentence needs, so "EXACT" is scoped to
// the choice of rendering rather than to the letters.
const targetInflectionInstruction = (targetLanguage: string) =>
  'Each target above is given in its dictionary form. Apply whatever ' +
  `morphological changes ${targetLanguage} grammar requires — case, number, ` +
  'agreement, derived forms, and the regular stem alternations these entail. ' +
  'What must never change is the choice of rendering: do not substitute a ' +
  'different translation, a different transliteration, or a more familiar ' +
  'variant of the term.';

export function buildGlossaryBlock(
  filtered: Map<string, string>,
  targetLanguage = '',
  termMetadata: TermMetadata = {},
): string {
  if (!filtered.size) return '';

  const lines = [
    '# GLOSSARY - REQUIRED TRANSLATIONS',
    '',
    'MANDATORY: use these EXACT translations whenever the source term appears.',
    'Do NOT paraphrase, transliterate differently, or invent alternatives.',
    ...(targetLanguageIsInflected(targetLanguage) ? [targetInflectionInstruction(targetLanguage)] : []),
    'Apply each rule consistently every time the term occurs.',
    'When several source forms are listed before the arrow (comma-separated), they are inflected variants of the same entity — translate any of them with the single target on the right.',
    'Bracketed hints after the arrow (e.g. [character, female]) describe the entity type and, where known, its gender — use them to disambiguate and to pick pronouns, never as part of the translation.',
    '',
  ];

  for (const [source, target] of filtered) {
    const meta = termMetadata[source] ?? {};
    const category = (meta.category ?? '').trim();
    const gender = normalizeGender(meta.gender);
    const displaySource = source.split('|').map((a) => a.trim()).filter(Boolean).join(', ') || source;
    const hints = [category, gender].filter(Boolean);
    lines.push(hints.length ? `  - ${displaySource} -> ${target}  [${hints.join(', ')}]` : `  - ${displaySource} -> ${target}`);
  }
  return `${lines.join('\n')}\n`;
}

/**
 * Every entity with a known gender, regardless of the current chunk: a passage that refers to a
 * character by pronoun alone contains no glossary match, yet is where a model would guess.
 */
export function buildCastBlock(
  terms: Map<string, string>,
  termMetadata: TermMetadata = {},
  maxEntries = DEFAULT_MAX_CAST_ENTRIES,
): { block: string; capped: boolean } {
  if (!terms.size || !Object.keys(termMetadata).length) return { block: '', capped: false };

  let entries: Array<[string, string, string]> = [];
  for (const [source, target] of terms) {
    const gender = normalizeGender(termMetadata[source]?.gender);
    if (!gender) continue;
    const canonical = source.split('|').map((a) => a.trim()).find(Boolean) ?? source;
    entries.push([canonical, target, gender]);
  }
  if (!entries.length) return { block: '', capped: false };

  let capped = false;
  if (maxEntries && entries.length > maxEntries) {
    capped = true;
    // Glossary order, not relevance: the block must be byte-identical across every chunk of a job.
    entries = entries.slice(0, maxEntries);
  }

  const lines = [
    '# CAST - CHARACTER GENDERS',
    '',
    'MANDATORY: each entity below has a fixed gender for the entire text.',
    'Use pronouns and gendered agreement matching the gender listed here, even when the source passage omits the subject or does not mark gender.',
    'Never default to masculine for an entity listed as female, and never switch an entity\'s gender between passages.',
    'This list is the reference for the whole work — an entity may be referred to here by pronoun only in the passage you are translating.',
    '',
  ];
  for (const [canonical, target, gender] of entries) {
    const label = target && target !== canonical ? `${canonical} (${target})` : canonical;
    lines.push(`  - ${label} — ${gender}`);
  }
  return { block: `${lines.join('\n')}\n`, capped };
}
