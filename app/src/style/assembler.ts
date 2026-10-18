// Port of src/core/style/assembler.py: turns validated style rules into the prose blocks injected
// into the translation and refinement prompts. Pure and deterministic.

import type { StyleMode } from '../prompts/prompts';

const TRANSLATION_PREAMBLE_SOURCE =
  'Match the following writing style in the translation. These rules describe how the ' +
  'text must read; they never authorize adding, removing, or altering content.';
const TRANSLATION_PREAMBLE_MODEL =
  'Imitate the following writing style, extracted from a reference work chosen as a ' +
  'stylistic model. Apply the rules to the translation while preserving the meaning of ' +
  'the source text exactly.';
const REFINEMENT_PREAMBLE_SOURCE =
  'Polish the already-translated text so that it matches the following writing style. ' +
  'Rewrite phrasing, rhythm and register as needed. Do not re-translate, do not add ' +
  'information, and do not change the meaning.';
const REFINEMENT_PREAMBLE_MODEL =
  'Polish the already-translated text so that it imitates the following writing style, ' +
  'extracted from a reference work chosen as a stylistic model. Rewrite phrasing, rhythm ' +
  'and register as needed. Do not re-translate, do not add information, and do not ' +
  'change the meaning.';

// Guards against the rules degenerating into a fixed vocabulary repeated chunk after chunk.
const ANTI_TIC_GUARD =
  'Treat these rules as tendencies of the writing, not as a vocabulary. Never reuse a ' +
  'fixed set of words, phrases, or images across passages: vary the wording naturally ' +
  'and let each sentence follow from its own content. Whenever a rule and the natural ' +
  'phrasing of a passage conflict, favour the natural phrasing.';

// Keeps the model from reaching for a word that belongs to a later era than the setting.
const SETTING_GUARD =
  'Do not use words that belong to a later era or a different technological level ' +
  'than this setting, even when they are the most direct equivalent.';

const PREAMBLES: Record<StyleMode, [string, string]> = {
  source: [TRANSLATION_PREAMBLE_SOURCE, REFINEMENT_PREAMBLE_SOURCE],
  model: [TRANSLATION_PREAMBLE_MODEL, REFINEMENT_PREAMBLE_MODEL],
};

export interface StyleRule {
  dimension: string;
  instruction: string;
  evidence?: string;
  flags?: string[];
}

export interface AssembledInstructions {
  translation: string | null;
  refinement: string | null;
}

export function assembleInstructions(mode: StyleMode, rules: StyleRule[], context = ''): AssembledInstructions {
  if (!(mode in PREAMBLES)) throw new Error(`unknown style mode: '${mode}'`);
  const [translationPreamble, refinementPreamble] = PREAMBLES[mode];

  const lines: string[] = [];
  for (const rule of rules) {
    let instruction = String(rule.instruction ?? '').trim();
    if (!instruction) continue;
    if (/[\p{L}\p{N}]/u.test(instruction[instruction.length - 1])) instruction += '.';
    lines.push(`- ${instruction}`);
  }
  if (!lines.length) return { translation: null, refinement: null };

  const body = lines.join('\n');
  const setting = context.trim();
  const content = setting ? `## Setting\n\n${setting}\n\n${SETTING_GUARD}\n\n## Style\n\n${body}` : body;
  return {
    translation: `${translationPreamble}\n\n${content}\n\n${ANTI_TIC_GUARD}`,
    refinement: `${refinementPreamble}\n\n${content}\n\n${ANTI_TIC_GUARD}`,
  };
}
