// Port of src/prompts/prompts.py (translation, subtitle and placeholder-correction
// prompts). Wording and whitespace are copied verbatim: tests compare the output
// with the Python implementation (test/fixtures/python-reference.json).

import {
  INPUT_TAG_IN,
  INPUT_TAG_OUT,
  PLACEHOLDER_PREFIX,
  PLACEHOLDER_SUFFIX,
  TRANSLATE_TAG_IN,
  TRANSLATE_TAG_OUT,
} from '../config';
import { TAG0, buildPlaceholderSection } from './examples';
import { normalizeLangKey } from './langKey';

export const CORRECTED_TAG_IN = '<CORRECTED_TAG_IN>';
export const CORRECTED_TAG_OUT = '<CORRECTED_TAG_OUT>';

export interface PromptPair {
  system: string;
  user: string;
}

export interface PromptOptions {
  text_cleanup?: boolean;
  custom_instructions?: string;
  /** Paragraph count of the segment being retried in Plain Text Mode (issue #253). */
  plain_text_expected_paragraphs?: number;
  [key: string]: unknown;
}

export const PLAIN_TEXT_EXPECTED_PARAGRAPHS_OPTION = 'plain_text_expected_paragraphs';

function getOutputFormatSection(
  translateTagIn: string,
  translateTagOut: string,
  inputTagIn: string,
  inputTagOut: string,
  additionalRules = '',
  exampleFormat = 'Your translated text here',
): string {
  const additionalRulesText = additionalRules ? `\n${additionalRules}` : '';
  return `# OUTPUT FORMAT

**CRITICAL OUTPUT RULES:**
1. Translate ONLY the text between "${inputTagIn}" and "${inputTagOut}" tags
2. Your response MUST start with ${translateTagIn} (first characters, no text before)
3. Your response MUST end with ${translateTagOut} (last characters, no text after)
4. Include NOTHING before ${translateTagIn} and NOTHING after ${translateTagOut}
5. Do NOT add explanations, comments, notes, or greetings${additionalRulesText}

**INCORRECT examples (DO NOT do this):**
❌ "Here is the translation: ${translateTagIn}Text...${translateTagOut}"
❌ "${translateTagIn}Text...${translateTagOut} (Additional comment)"
❌ "Sure! ${translateTagIn}Text...${translateTagOut}"
❌ "Text..." (missing tags entirely)
❌ "${translateTagIn}Text..." (missing closing tag)

**CORRECT format (ONLY this):**
✅ ${translateTagIn}
${exampleFormat}
${translateTagOut}
`;
}

// Numbering starts at 6 because rules 1-5 are emitted by getOutputFormatSection.
const SUBTITLE_FORMAT_RULES =
  '\n6. Each subtitle has an index marker: [index]text - PRESERVE these markers exactly' +
  '\n7. Keep ONE [index] per subtitle - do NOT merge or split subtitles' +
  '\n8. Maintain line breaks between indexed subtitles' +
  '\n9. Preserve inline tags (<i>, <b>, <u>, <font ...>, {\\an8}, etc.) and any \\n line breaks INSIDE a subtitle exactly as in the source';

// Emitted only in Plain Text Mode: the paragraph-count reconciliation downstream
// cannot absorb a model that merges or splits paragraphs.
const PLAIN_TEXT_FORMAT_RULES =
  '\n6. The input contains paragraphs separated by ONE BLANK LINE' +
  '\n7. Output EXACTLY the same number of paragraphs, in the same order' +
  '\n8. Separate every output paragraph with ONE BLANK LINE - never a single newline' +
  '\n9. Do NOT merge two paragraphs into one, and do NOT split one paragraph into two' +
  '\n10. An empty input paragraph stays empty - do not fill it' +
  '\n11. Do NOT add markdown heading markers (#, ##, ###, etc.) or any other ' +
  'markdown formatting symbols to your output - output plain translated text only';

function plainTextFormatRules(promptOptions?: PromptOptions): string {
  const expected = promptOptions?.[PLAIN_TEXT_EXPECTED_PARAGRAPHS_OPTION];
  if (typeof expected !== 'number' || !Number.isInteger(expected) || expected < 1) {
    return PLAIN_TEXT_FORMAT_RULES;
  }
  return (
    PLAIN_TEXT_FORMAT_RULES +
    '\n12. RETRY: your previous answer for this exact text had the WRONG number of paragraphs' +
    `\n13. This input contains EXACTLY ${expected} paragraph(s); your output MUST contain ` +
    `EXACTLY ${expected} paragraph(s), separated by ONE BLANK LINE` +
    "\n14. Count the paragraphs before answering. A disclaimer, an author's note, a chapter " +
    'heading or any short standalone line IS a paragraph and IS content: translate each one ' +
    'as its own paragraph - never drop it, never fold it into the next one, never summarize it'
  );
}

const TEXT_CLEANUP_SECTION = `
# TEXT CLEANUP (Source Defects Correction)

The source text may contain OCR errors, formatting artifacts, or typographic defects.
**CORRECT THESE ISSUES during translation:**

- **Line breaks**: Fix broken words (e.g., "trans-\\nlation" → "translation")
- **Spacing**: Remove double spaces, fix missing spaces after punctuation
- **Punctuation**: Correct misplaced or missing punctuation marks
- **Paragraph flow**: Merge incorrectly split paragraphs, preserve intentional breaks

**DO NOT** add content, remove meaningful text, or alter the author's style.`;

const TEXT_CLEANUP_SECTION_PLAIN = TEXT_CLEANUP_SECTION.replace(
  '- **Paragraph flow**: Merge incorrectly split paragraphs, preserve intentional breaks',
  '- **Paragraph flow**: Keep the paragraph breaks exactly as they are - never merge or split paragraphs',
);

function buildOptionalPromptSections(promptOptions: PromptOptions, plainText = false): string {
  const sections: string[] = [];
  if (promptOptions.text_cleanup) {
    sections.push(plainText ? TEXT_CLEANUP_SECTION_PLAIN : TEXT_CLEANUP_SECTION);
  }
  return sections.join('\n\n');
}

function exampleTexts(hasPlaceholders: boolean): Record<string, string> {
  const t = (plain: string, withTags: string) => (hasPlaceholders ? withTags : plain);
  return {
    chinese: t('您翻译的文本在这里', `您翻译的文本在这里，所有${TAG0}标记都精确保留`),
    french: t('Votre texte traduit ici', `Votre texte traduit ici, tous les marqueurs ${TAG0} sont préservés exactement`),
    spanish: t('Su texto traducido aquí', `Su texto traducido aquí, todos los marcadores ${TAG0} se preservan exactamente`),
    german: t('Ihr übersetzter Text hier', `Ihr übersetzter Text hier, alle ${TAG0}-Markierungen werden genau beibehalten`),
    japanese: t('翻訳されたテキストはこちら', `翻訳されたテキストはこちら、すべての${TAG0}マーカーは正確に保持されます`),
    italian: t('Il tuo testo tradotto qui', `Il tuo testo tradotto qui, tutti i marcatori ${TAG0} sono conservati esattamente`),
    portuguese: t('Seu texto traduzido aqui', `Seu texto traduzido aqui, todos os marcadores ${TAG0} são preservados exatamente`),
    russian: t('Ваш переведенный текст здесь', `Ваш переведенный текст здесь, все маркеры ${TAG0} сохранены точно`),
    korean: t('번역된 텍스트는 여기에', `번역된 텍스트는 여기에, 모든 ${TAG0} 마커는 정확히 보존됩니다`),
  };
}

export interface TranslationPromptArgs {
  mainContent: string;
  contextBefore: string;
  contextAfter: string;
  previousTranslationContext: string;
  sourceLanguage?: string;
  targetLanguage?: string;
  translateTagIn?: string;
  translateTagOut?: string;
  /** True for EPUB-style input where HTML tags were replaced by [idN] placeholders. */
  hasPlaceholders?: boolean;
  promptOptions?: PromptOptions;
  glossaryBlock?: string;
}

export function generateTranslationPrompt({
  mainContent,
  previousTranslationContext,
  sourceLanguage = 'English',
  targetLanguage = 'English',
  translateTagIn = TRANSLATE_TAG_IN,
  translateTagOut = TRANSLATE_TAG_OUT,
  hasPlaceholders = true,
  promptOptions = {},
  glossaryBlock = '',
}: TranslationPromptArgs): PromptPair {
  const customInstructions = promptOptions.custom_instructions ?? '';

  const exampleFormatText = exampleTexts(hasPlaceholders)[normalizeLangKey(targetLanguage)] ?? 'Your translated text here';

  const outputFormatSection = getOutputFormatSection(
    translateTagIn,
    translateTagOut,
    INPUT_TAG_IN,
    INPUT_TAG_OUT,
    !hasPlaceholders ? plainTextFormatRules(promptOptions) : '',
    exampleFormatText,
  );

  const placeholderSection = hasPlaceholders ? buildPlaceholderSection(sourceLanguage, targetLanguage) : '';
  const optionalSections = buildOptionalPromptSections(promptOptions, !hasPlaceholders);

  let customInstructionsSection = '';
  if (customInstructions && customInstructions.trim()) {
    customInstructionsSection = `# STYLE INSTRUCTIONS

**Apply these throughout the translation. They take precedence over the general style guidance in this prompt.**

${customInstructions.trim()}

Keep them in force across the whole passage, not only in its opening lines.

`;
  }

  const upper = targetLanguage.toUpperCase();
  const systemPrompt = `You are a professional ${targetLanguage} translator and writer.

${customInstructionsSection}# TRANSLATION PRINCIPLES

Translate ${sourceLanguage} to ${targetLanguage}. Output only the translation.

**PRIORITY ORDER:**
1. Preserve exact names
2. Match original tone and formality
3. Use natural ${targetLanguage} phrasing - never word-for-word
4. Fix grammar/spelling errors in output
5. Translate idioms to ${targetLanguage} equivalents

**QUALITY CHECK:**
- Does it sound natural to a native ${targetLanguage} speaker?
- Are all details from the original included?
- Does punctuation follow ${targetLanguage} conventions?

If unsure between literal and natural phrasing: **choose natural**.

**LAYOUT PRESERVATION:**
- Keep the exact text layout, spacing, line breaks, and indentation
- **WRITE YOUR TRANSLATION IN ${upper} - THIS IS MANDATORY**
${optionalSections}
${placeholderSection}

# FINAL REMINDER: YOUR OUTPUT LANGUAGE

**YOU MUST TRANSLATE INTO ${upper}.**
Your entire translation output must be written in ${targetLanguage}.
Do NOT write in ${sourceLanguage} or any other language - ONLY ${upper}.

${outputFormatSection}`;

  let previousTranslationBlockText = '';
  if (previousTranslationContext && previousTranslationContext.trim()) {
    previousTranslationBlockText = `# CONTEXT - Previous Paragraph

For consistency and natural flow, here's what came immediately before:

${previousTranslationContext}

`;
  }

  // The glossary changes per chunk, so it stays out of the (cacheable) system prompt.
  const glossarySection = glossaryBlock && glossaryBlock.trim() ? `${glossaryBlock}\n` : '';

  const userPrompt = `${previousTranslationBlockText}${glossarySection}# TEXT TO TRANSLATE

${INPUT_TAG_IN}
${mainContent}
${INPUT_TAG_OUT}

REMINDER: Output ONLY your translation in this exact format:
${translateTagIn}
your translation here
${translateTagOut}

Start with ${translateTagIn} and end with ${translateTagOut}. Nothing before or after.

Provide your translation now:`;

  return { system: systemPrompt.trim(), user: userPrompt.trim() };
}

export interface SubtitlePromptArgs {
  subtitleBlocks: Array<[number, string]>;
  previousTranslationBlock: string;
  sourceLanguage?: string;
  targetLanguage?: string;
  translateTagIn?: string;
  translateTagOut?: string;
  customInstructions?: string;
  glossaryBlock?: string;
}

export function generateSubtitleBlockPrompt({
  subtitleBlocks,
  previousTranslationBlock,
  sourceLanguage = 'English',
  targetLanguage = 'English',
  translateTagIn = TRANSLATE_TAG_IN,
  translateTagOut = TRANSLATE_TAG_OUT,
  customInstructions = '',
  glossaryBlock = '',
}: SubtitlePromptArgs): PromptPair {
  const outputFormatSection = getOutputFormatSection(
    translateTagIn,
    translateTagOut,
    INPUT_TAG_IN,
    INPUT_TAG_OUT,
    SUBTITLE_FORMAT_RULES,
    '[1]第一行翻译文本\n[2]第二行翻译文本',
  );

  let customInstructionsSection = '';
  if (customInstructions && customInstructions.trim()) {
    customInstructionsSection = `

# STYLE INSTRUCTIONS

**Apply these throughout the translation. They take precedence over the general style guidance in this prompt.**

${customInstructions.trim()}

Keep them in force across every subtitle in the batch, not only the first few.
`;
  }

  const upper = targetLanguage.toUpperCase();
  const systemPrompt = `You are a professional ${targetLanguage} subtitle translator and dialogue adaptation specialist.

# CRITICAL: TARGET LANGUAGE IS ${upper}

**YOUR SUBTITLE TRANSLATION MUST BE WRITTEN ENTIRELY IN ${upper}.**

You are translating subtitles FROM ${sourceLanguage} TO ${targetLanguage}.
Your output must be in ${targetLanguage} ONLY - do NOT use any other language.

# SUBTITLE TRANSLATION PRINCIPLES

**Quality Standards:**
- Translate dialogues naturally and conversationally for ${targetLanguage} viewers
- Adapt expressions, slang, and cultural references appropriately
- Keep subtitle length readable (typically 40-42 characters per line)
- Restructure sentences naturally (avoid word-by-word translation)
- Maintain speaker's tone, personality, and emotion
- **WRITE YOUR TRANSLATION IN ${upper} - THIS IS MANDATORY**

**Subtitle-Specific Rules:**
- Prioritize clarity and reading speed over literal accuracy
- Condense when necessary without losing meaning
- Use natural, spoken ${targetLanguage} (not formal written style)
- Preserve intentional repetitions (e.g. "No. No. No.") and dialogue dashes ("- ...\\n- ...") from the source
- Preserve inline formatting tags (<i>, <b>, <font ...>, {\\an8}, etc.) and any \\n line breaks inside a subtitle${customInstructionsSection}

# FINAL REMINDER: YOUR OUTPUT LANGUAGE

**YOU MUST TRANSLATE INTO ${upper}.**
Your entire subtitle translation must be written in ${targetLanguage}.
Do NOT write in ${sourceLanguage} or any other language - ONLY ${upper}.

${outputFormatSection}`;

  let previousBlockText = '';
  if (previousTranslationBlock && previousTranslationBlock.trim()) {
    previousBlockText = `# CONTEXT - Previous Subtitle Block

For continuity and consistency, here's the previous subtitle block:

${previousTranslationBlock}

`;
  }

  const formattedSubtitlesText = subtitleBlocks.map(([idx, text]) => `[${idx}]${text}`).join('\n');
  const glossarySection = glossaryBlock && glossaryBlock.trim() ? `${glossaryBlock}\n` : '';

  const userPrompt = `${previousBlockText}${glossarySection}# SUBTITLES TO TRANSLATE

${INPUT_TAG_IN}
${formattedSubtitlesText}
${INPUT_TAG_OUT}

REMINDER: Output format must be:
${translateTagIn}
[1]translated subtitle 1
[2]translated subtitle 2
${translateTagOut}

Start with ${translateTagIn} and end with ${translateTagOut}. Nothing before or after.

Provide your translation now:`;

  return { system: systemPrompt.trim(), user: userPrompt.trim() };
}

export interface PlaceholderCorrectionArgs {
  originalText: string;
  translatedText: string;
  specificErrors: string;
  sourceLanguage: string;
  targetLanguage: string;
  expectedCount: number;
  placeholderFormat?: [string, string];
}

export function generatePlaceholderCorrectionPrompt({
  originalText,
  translatedText,
  specificErrors,
  sourceLanguage,
  targetLanguage,
  expectedCount,
  placeholderFormat,
}: PlaceholderCorrectionArgs): PromptPair {
  const [prefix, suffix] = placeholderFormat ?? [PLACEHOLDER_PREFIX, PLACEHOLDER_SUFFIX];
  const makePlaceholder = (idx: number) => `${prefix}${idx}${suffix}`;

  const maxIndex = expectedCount > 0 ? expectedCount - 1 : 0;
  const placeholderFormatStr = `${prefix}N${suffix}`;
  const exampleRange = `${makePlaceholder(0)} to ${makePlaceholder(maxIndex)}`;
  let placeholderList = Array.from({ length: Math.min(3, expectedCount) }, (_, i) => makePlaceholder(i)).join(', ');
  if (expectedCount > 3) placeholderList += ', etc.';

  const systemPrompt = `You are a technical placeholder correction specialist.

## YOUR TASK

A ${sourceLanguage} to ${targetLanguage} translation was performed, but the placeholders were corrupted.
You must fix the placeholder positions to match the original text structure.

## PLACEHOLDER FORMAT

**CORRECT format:** ${makePlaceholder(0)}, ${makePlaceholder(1)}, ${makePlaceholder(2)}, etc.
- Brackets: ${prefix} and ${suffix}
- Sequential numbering starting from 0
- Expected range for this text: ${exampleRange}

**FORMAT VARIATIONS:**
The system uses different placeholder formats based on text content:
- [id0], [id1], [id2]... (default - semantic markers, highest accuracy)
- /0, /1, /2... (when text contains brackets)
- $0$, $1$, $2$... (when text contains brackets and slashes)
- [[0]], [[1]], [[2]]... (legacy format)

All formats follow the same rules: preserve exact format, maintain sequential order, keep position.

## HOW TO POSITION PLACEHOLDERS

Placeholders represent HTML/XML tags. To position them correctly:

1. **Look at the ORIGINAL text** to see what content each placeholder surrounds
2. **Find the equivalent content** in the translation
3. **Place the placeholder at the same logical position** around that content

**Example:**
- Original: "${makePlaceholder(0)}Hello${makePlaceholder(1)} world"
- If translation is "Bonjour monde", the placeholders mark "Hello"
- Correct: "${makePlaceholder(0)}Bonjour${makePlaceholder(1)} monde"

## VALIDATION RULES

1. **EXACT COUNT**: Must contain exactly ${expectedCount} placeholders
2. **SEQUENTIAL ORDER**: Placeholders must appear in order: ${placeholderList}
3. **NO DUPLICATES**: Each placeholder must appear exactly once
4. **NO MUTATIONS**: Use ONLY the ${placeholderFormatStr} format
5. **POSITION MATCHING**: Each placeholder must surround the translated equivalent of what it surrounded in the original

## CRITICAL INSTRUCTIONS

- Analyze the ORIGINAL to understand what each placeholder marks
- Position placeholders around the SAME semantic content in the translation
- Do NOT add or remove words from the translation
- Keep the ${targetLanguage} text intact, only fix placeholder positions

## OUTPUT FORMAT

Your response MUST start with ${CORRECTED_TAG_IN} and end with ${CORRECTED_TAG_OUT}.
Include NOTHING before or after these tags.`;

  const userPrompt = `## ORIGINAL TEXT (${sourceLanguage}) - Reference for placeholder positions:

<ORIGINAL_TAG_IN>
${originalText}
<ORIGINAL_TAG_OUT>

## TRANSLATION WITH ERRORS (${targetLanguage}):

<TRANSLATION_TAG_IN>
${translatedText}
<TRANSLATION_TAG_OUT>

## DETECTED ERRORS:

${specificErrors}

## YOUR TASK:

Reposition the placeholders ${exampleRange} in the translation above.
Keep the translated text unchanged - only fix placeholder positions.

Provide your corrected version now:`;

  return { system: systemPrompt.trim(), user: userPrompt.trim() };
}

// ============================================================================
// GLOSSARY: NER EXTRACTION PROMPT
// ============================================================================

export const NER_TAG_IN = '<NER_JSON>';
export const NER_TAG_OUT = '</NER_JSON>';

/**
 * Asks the model for recurring proper nouns with a suggested translation and, for characters,
 * the gender evidenced by the passage. The gender is evidence-only with an explicit "unknown"
 * escape hatch: a confidently wrong gender is worse than a blank the user reviews.
 */
export function generateNerExtractionPrompt(text: string, sourceLanguage = 'Chinese', targetLanguage = 'English'): PromptPair {
  const systemPrompt = `You are a literary entity extractor. Your job is to read a passage written in ${sourceLanguage} and identify recurring proper nouns that a translator would want to keep consistent across an entire book.

# CATEGORIES (use exactly these labels)

- "character"     — named persons (李凡, Li Fan, Captain Ahab)
- "location"      — places, regions, buildings (青玄宗大殿, Mount Tai)
- "organization"  — sects, schools, clans, factions, companies (青玄宗, Heavenly Sword Gate)
- "item"          — named artifacts, weapons, treasures, techniques (混沌珠, Excalibur)
- "title"         — honorifics or named ranks tied to a person (Elder, 长老, Master)
- "other"         — anything else worth keeping consistent (events, magical formulas)

# RULES

1. Extract ONLY proper nouns or named concepts that look likely to recur. Skip generic words.
2. Do NOT translate common nouns or descriptive phrases — only named entities.
3. For each entity, propose ONE canonical ${targetLanguage} translation. Use the standard romanization or the most natural literary rendering. Keep the proposal concise.
4. Deduplicate: if the same entity appears multiple times in the passage, list it once.
5. If you are unsure about an entry, omit it rather than guessing.
6. Preserve the original ${sourceLanguage} form exactly as it appears in the text (no extra spaces, no normalization).

# GENDER

For entities in the "character" category, also report the character's gender. This matters because ${sourceLanguage} may not mark gender the way ${targetLanguage} does: when a passage omits the subject or uses an unmarked pronoun, a translator with no gender information defaults every character to "he" and silently corrupts the cast across a whole book.

Determine gender ONLY from evidence in the passage: gendered pronouns (她 / 彼女 / she), gendered forms of address or kinship terms (姐姐, 母亲, Miss, Lady, sir), or explicit description. Do NOT guess from the name itself, and do NOT assume a protagonist is male.

Report exactly one of:
  - "female"  — the passage shows this character is female
  - "male"    — the passage shows this character is male
  - "unknown" — no gender evidence in the passage, or the entity is not a character

"unknown" is the correct, expected answer whenever the evidence is absent. A wrong guess is far more damaging than an honest "unknown", because the user reviews unknowns but trusts stated genders.

# OUTPUT FORMAT

Return ONLY a JSON array wrapped between ${NER_TAG_IN} and ${NER_TAG_OUT}. No prose, no explanations.

Each array element MUST be an object with these keys:
  - "source"   (string, required) — the entity in ${sourceLanguage}
  - "target"   (string, required) — the proposed ${targetLanguage} translation
  - "category" (string, required) — one of the labels listed above
  - "gender"   (string, required) — "female", "male", or "unknown"

Example:
${NER_TAG_IN}
[
  {"source": "李凡", "target": "Li Fan", "category": "character", "gender": "male"},
  {"source": "林月", "target": "Lin Yue", "category": "character", "gender": "female"},
  {"source": "沈青", "target": "Shen Qing", "category": "character", "gender": "unknown"},
  {"source": "青玄宗", "target": "Qingxuan Sect", "category": "organization", "gender": "unknown"}
]
${NER_TAG_OUT}

If no entities are found, return an empty array: ${NER_TAG_IN}[]${NER_TAG_OUT}.

Do NOT wrap the JSON in markdown code fences. Do NOT add commentary before or after the tags.`;

  const userPrompt = `# SOURCE TEXT (${sourceLanguage})

${INPUT_TAG_IN}
${text}
${INPUT_TAG_OUT}

Extract the recurring named entities now. Output the JSON array between ${NER_TAG_IN} and ${NER_TAG_OUT}, nothing else.`;

  return { system: systemPrompt.trim(), user: userPrompt.trim() };
}

// ============================================================================
// STYLE EXTRACTION PROMPT
// ============================================================================

export const STYLE_TAG_IN = '<STYLE_JSON>';
export const STYLE_TAG_OUT = '</STYLE_JSON>';

export type StyleMode = 'source' | 'model';

/**
 * Asks the model to characterise HOW a text is written and return abstract, atomic style rules.
 * "source": the passages are the text about to be translated. "model": the passages are a
 * reference author whose style an unrelated text should imitate.
 */
export function generateStyleExtractionPrompt(
  text: string,
  mode: StyleMode,
  sourceLanguage = 'English',
  targetLanguage = 'English',
): PromptPair {
  if (mode !== 'source' && mode !== 'model') throw new Error(`mode must be 'source' or 'model', got '${mode}'`);

  let roleFraming: string;
  let contextDirective: string;
  let contextExample: string;
  if (mode === 'source') {
    roleFraming =
      'The passages below are the SOURCE TEXT that is about to be translated. ' +
      'Produce rules a translator must follow so that the translation reads like the original.';
    contextDirective = `# CONTEXT FIELD (mandatory)

The "context" field must be 1 to 3 sentences, at most 400 characters, written in English. Describe the world the passages take place in: the historical period (or its secondary-world equivalent), the technological level, the social and cultural frame, and anything else that would make a modern word feel out of place if used in the translation.

Forbidden in "context": proper nouns, character names, place names, and any summary of the plot.

This field exists so the translator never reaches for a word that belongs to a later era or a different technological level than this setting, even when it would otherwise be the most direct equivalent.`;
    contextExample =
      '"context": "A late-medieval frontier town under martial law, with no gunpowder ' +
      'weapons and a rigid guild hierarchy.",';
  } else {
    roleFraming =
      'The passages below are a REFERENCE WORK chosen as a stylistic model. ' +
      'Produce rules a translator must follow to make an unrelated text read like this author.';
    contextDirective = `# CONTEXT FIELD (mandatory)

The "context" field MUST be the empty string "". These passages are only a stylistic model for an unrelated text: the reference work's own setting must never be imposed on the text that will actually be translated.`;
    contextExample = '"context": "",';
  }

  const systemPrompt = `You are a literary style analyst. Your job is to read the passages below and characterize HOW the text is written, never WHAT it says. Ignore plot, characters, and setting entirely; focus only on the craft choices a translator could reproduce.

${roleFraming}

# DIMENSIONS (use exactly these labels)

- "register"         — formality, distance, irony, emotional temperature
- "narrative_voice"  — person, tense, focalization, narrator presence
- "sentence_rhythm"  — length distribution, parataxis vs subordination, cadence
- "lexicon"          — concrete vs abstract, recurring lexical fields, archaisms
- "imagery"          — metaphors, similes, recurring figurative motifs
- "dialogue"         — speech tags, orality, idiolects, interruption handling
- "punctuation"      — em-dashes, semicolons, ellipses, exclamation frequency
- "formatting"       — paragraph length, italics usage, section breaks
- "other"            — anything else worth capturing that does not fit above

# LANGUAGE OF THE INSTRUCTIONS

Write every instruction in English, regardless of the language of the passages. This directive holds even when the passages are in one language and the translation target is a different, third language.

# ABSTRACTION DIRECTIVE (mandatory)

Every instruction must describe a PROPERTY of the writing, never the specific words that realize it. Naming specific vocabulary is a trap: the translator will repeat that exact vocabulary across the whole book, and it will read as a tic.

Forbidden, in every instruction:
1. No quoted material from the passages, and no quotation marks at all.
2. No example words, phrases, idioms or turns of phrase to use.
3. No "such as", "e.g.", "for example", "words like", "expressions like".
4. No proper nouns, no invented terminology, no lexical field named as a word list.
5. No instruction that can be satisfied by inserting one specific token.

Describe the CHOICE being made instead: proportion, frequency, position, contrast, degree, consistency.

Example:
- rejected: Use metaphors of darkness and shadow, and words like "dusk" and "gloom".
- accepted: Draw figurative language from a single consistent sensory field rather than varying its source from one image to the next.

# RULES FOR EACH INSTRUCTION

1. One imperative sentence, self-contained, actionable by a translator who has not read the passages.
2. At most 240 characters.
3. Must not mention characters, places, or plot from the passages.
4. Return between 6 and 14 rules in total, at most 3 rules per dimension. Omit a dimension rather than padding it — 6 abstract rules are better than 14 that name vocabulary.

${contextDirective}

# OUTPUT FORMAT

Return ONLY a JSON object wrapped between ${STYLE_TAG_IN} and ${STYLE_TAG_OUT}. No prose, no explanations, no markdown code fences.

The JSON object MUST have these keys:
  - "summary"         (string, required) — one sentence, at most 120 characters, usable as a preset description
  - "suggested_name"  (string, required) — 2 to 4 lowercase words joined by underscores, ASCII only (e.g. "dry_hardboiled_noir")
  - "context"         (string, required) — see the CONTEXT FIELD section above for the exact requirement
  - "rules"           (array, required) — a list of objects, each with:
      - "dimension"   (string, required) — one of the dimension labels listed above
      - "instruction" (string, required) — the abstract, imperative style rule, in English
      - "evidence"    (string, required, at most 120 characters) — a short quotation from the passages that justifies the rule

"evidence" is the ONLY field allowed to quote the passages. It is shown to the human reviewer as justification for the rule and is discarded afterwards — it never becomes part of the preset. This separation is what lets "instruction" stay fully abstract without losing the reviewer's ability to check the claim.

Example:
${STYLE_TAG_IN}
{
  "summary": "Terse, present-tense narration with clipped dialogue and sparse punctuation.",
  "suggested_name": "terse_present_tense",
  ${contextExample}
  "rules": [
    {"dimension": "sentence_rhythm", "instruction": "Favor short, paratactic sentences over long subordinated ones, especially in action passages.", "evidence": "He ran. He did not look back."}
  ]
}
${STYLE_TAG_OUT}

Do NOT wrap the JSON in markdown code fences. Do NOT add commentary before or after the tags.`;

  const languageNote =
    mode === 'source'
      ? `The passages are in ${sourceLanguage}. The rules you produce will be applied to a translation into ${targetLanguage}.`
      : `The passages are already in ${targetLanguage}, the target language of the translation these rules will later be applied to.`;

  const userPrompt = `# PASSAGES

${languageNote}

${INPUT_TAG_IN}
${text}
${INPUT_TAG_OUT}

Produce the JSON now. Output it between ${STYLE_TAG_IN} and ${STYLE_TAG_OUT}, nothing else.`;

  return { system: systemPrompt.trim(), user: userPrompt.trim() };
}

// ============================================================================
// REFINEMENT PROMPTS
// ============================================================================

export interface RefinementPromptArgs {
  draftTranslation: string;
  /** Accepted for parity with the Python signature; the prompt does not use it. */
  contextBefore?: string;
  contextAfter?: string;
  previousRefinedContext?: string;
  targetLanguage?: string;
  translateTagIn?: string;
  translateTagOut?: string;
  hasPlaceholders?: boolean;
  promptOptions?: PromptOptions;
  additionalInstructions?: string;
  glossaryBlock?: string;
}

const REFINED_EXAMPLES: Record<string, string> = {
  chinese: '您润色后的文本在这里',
  french: 'Votre texte affiné ici',
  spanish: 'Su texto refinado aquí',
  german: 'Ihr verfeinerter Text hier',
  japanese: '洗練されたテキストはこちら',
  italian: 'Il tuo testo raffinato qui',
  portuguese: 'Seu texto refinado aqui',
  russian: 'Ваш улучшенный текст здесь',
  korean: '다듬어진 텍스트는 여기에',
};

/**
 * Prompt for the second pass: rewrite an already-translated draft into polished prose in the
 * same language. The input is monolingual, so the placeholder example uses the target language
 * on both sides.
 */
export function generateRefinementPrompt({
  draftTranslation,
  previousRefinedContext = '',
  targetLanguage = 'English',
  translateTagIn = TRANSLATE_TAG_IN,
  translateTagOut = TRANSLATE_TAG_OUT,
  hasPlaceholders = true,
  promptOptions = {},
  additionalInstructions = '',
  glossaryBlock = '',
}: RefinementPromptArgs): PromptPair {
  const exampleFormatText = REFINED_EXAMPLES[normalizeLangKey(targetLanguage)] ?? 'Your refined text here';
  const outputFormatSection = getOutputFormatSection(translateTagIn, translateTagOut, INPUT_TAG_IN, INPUT_TAG_OUT, '', exampleFormatText);
  const placeholderSection = hasPlaceholders ? buildPlaceholderSection(targetLanguage, targetLanguage) : '';
  const optionalSections = buildOptionalPromptSections(promptOptions);

  let additionalInstructionsSection = '';
  if (additionalInstructions && additionalInstructions.trim()) {
    additionalInstructionsSection = `

# ADDITIONAL REFINEMENT INSTRUCTIONS

${additionalInstructions.trim()}`;
  }

  const upper = targetLanguage.toUpperCase();
  const systemPrompt = `You are an elite ${targetLanguage} literary editor and prose stylist.

# YOUR TASK: REFINE AND POLISH

You will receive a DRAFT ${targetLanguage} translation that needs significant improvement.
Your job is to REWRITE it with perfect literary ${targetLanguage} style.

**THE INPUT IS:**
- A amator, literal, or awkward ${targetLanguage} translation
- It may have unnatural phrasing, stilted expressions, or poor flow
- Consider it a "bad" first draft that probably needs substantial reworking

**YOUR OUTPUT MUST BE:**
- Fluent, natural ${targetLanguage} prose
- Stylistically excellent - as if written by a skilled ${targetLanguage} author

# REFINEMENT PRINCIPLES

**PRIORITY ORDER:**
1. **Natural flow** - Sentences should flow beautifully in ${targetLanguage}
2. **Idiomatic expressions** - Use natural ${targetLanguage} idioms and phrasings
3. **Elegant word choice** - Select the most appropriate and refined vocabulary
4. **Rhythm and cadence** - The text should have pleasant reading rhythm
5. **Preserve meaning** - Keep the original meaning intact while improving style

**WHAT TO FIX:**
- Awkward literal translations → Natural ${targetLanguage} expressions
- Repetitive or dull vocabulary → Rich, varied word choices
- Unnatural word order → Proper ${targetLanguage} syntax
- **Lexical repetitions and cacophony** → Use synonyms to avoid same-root word repetition
  (e.g., "the singer sang a song" → "the singer performed a song" or "the vocalist sang a melody")

**WHAT TO PRESERVE:**
- All factual content and meaning
- Character names and proper nouns
- Technical terms (if any)
${optionalSections}
${placeholderSection}
${additionalInstructionsSection}

# CRITICAL REMINDER

You are NOT translating - you are REWRITING in ${upper}.
The input is already in ${targetLanguage}, but poorly written.
Your output must be polished, literary-quality ${targetLanguage}.

**⚠️ PLACEHOLDER PRESERVATION IS ABSOLUTELY CRITICAL:**
If the input contains ANY placeholders (like [id0], [id1], etc.), you MUST preserve them EXACTLY.
Removing or corrupting placeholders will corrupt the document structure.
Your refinement MUST maintain the exact same placeholders in the exact same positions.

${outputFormatSection}`;

  let previousContextBlock = '';
  if (previousRefinedContext && previousRefinedContext.trim()) {
    previousContextBlock = `# CONTEXT - Previous Refined Paragraph

For consistency and natural flow, here's what came immediately before:

${previousRefinedContext}

`;
  }

  // The glossary changes per chunk, so it stays out of the (cacheable) system prompt.
  const glossarySection = glossaryBlock && glossaryBlock.trim() ? `${glossaryBlock}\n` : '';

  const userPrompt = `${previousContextBlock}${glossarySection}# DRAFT TO REFINE

The following is a rough ${targetLanguage} translation that needs significant improvement.
Rewrite it with elegant, literary-quality ${targetLanguage} prose:

${INPUT_TAG_IN}
${draftTranslation}
${INPUT_TAG_OUT}

REMINDER: Output ONLY your refined text in this exact format:
${translateTagIn}
your refined text here
${translateTagOut}

Start with ${translateTagIn} and end with ${translateTagOut}. Nothing before or after.

Provide your refined version now:`;

  return { system: systemPrompt.trim(), user: userPrompt.trim() };
}

/** Same prompt under the name the EPUB path uses; the previous-context argument is not used. */
export function generatePostProcessingPrompt(args: Omit<RefinementPromptArgs, 'draftTranslation' | 'previousRefinedContext'> & { translatedText: string }): PromptPair {
  const { translatedText, ...rest } = args;
  return generateRefinementPrompt({ ...rest, draftTranslation: translatedText, previousRefinedContext: '' });
}

export interface SubtitleRefinementArgs {
  subtitleBlocks: Array<[number, string]>;
  previousRefinedBlock?: string;
  targetLanguage?: string;
  translateTagIn?: string;
  translateTagOut?: string;
  additionalInstructions?: string;
  glossaryBlock?: string;
}

/** Refines a block of subtitles in one call, keeping the `[index]` markers. */
export function generateSubtitleRefinementBlockPrompt({
  subtitleBlocks,
  previousRefinedBlock = '',
  targetLanguage = 'English',
  translateTagIn = TRANSLATE_TAG_IN,
  translateTagOut = TRANSLATE_TAG_OUT,
  additionalInstructions = '',
  glossaryBlock = '',
}: SubtitleRefinementArgs): PromptPair {
  const outputFormatSection = getOutputFormatSection(
    translateTagIn, translateTagOut, INPUT_TAG_IN, INPUT_TAG_OUT, SUBTITLE_FORMAT_RULES,
    '[0]Première ligne affinée\n[1]Deuxième ligne affinée',
  );

  let additionalInstructionsSection = '';
  if (additionalInstructions && additionalInstructions.trim()) {
    additionalInstructionsSection = `

# ADDITIONAL REFINEMENT INSTRUCTIONS

${additionalInstructions.trim()}`;
  }

  const upper = targetLanguage.toUpperCase();
  const systemPrompt = `You are an elite ${targetLanguage} subtitle editor and dialogue stylist.

# YOUR TASK: REFINE A BLOCK OF SUBTITLES

You will receive a block of DRAFT ${targetLanguage} subtitles, each prefixed with an [index] marker.
Your job is to REWRITE each subtitle with natural, idiomatic ${targetLanguage} dialogue while
preserving the index markers and the one-subtitle-per-marker structure.

**THE INPUT IS:**
- A block of draft ${targetLanguage} subtitles, possibly literal or awkward
- Each subtitle is prefixed with [N] where N is its local index

**YOUR OUTPUT MUST BE:**
- The same number of subtitles, each prefixed with the SAME [N] marker
- Fluent, natural spoken ${targetLanguage} suited to subtitling

# REFINEMENT PRINCIPLES

**PRIORITY ORDER:**
1. **Natural dialogue** - sound like real ${targetLanguage} speech, not translation
2. **Reading speed** - keep subtitle length viewer-friendly
3. **Continuity** - terminology and tone consistent across the block
4. **Preserve meaning** - keep the original meaning intact while improving style

**WHAT TO FIX:**
- Awkward literal phrasing -> natural ${targetLanguage} expressions
- Repetitive vocabulary that is clearly an artefact of literal translation -> varied word choices
- Unnatural word order -> proper ${targetLanguage} syntax

**WHAT TO PRESERVE:**
- The [index] markers exactly as given
- All factual content and meaning
- Character names and proper nouns
- The one-subtitle-per-[index] structure (no merging, no splitting)
- Intentional repetitions (e.g. "No. No. No.") and dialogue dashes ("- ...\\n- ...") when present in the draft
- Inline formatting tags and any \\n line breaks inside a subtitle${additionalInstructionsSection}

# CRITICAL REMINDERS

You are NOT translating - you are REWRITING in ${upper}.
The input is already in ${targetLanguage}, but possibly poorly written.
Your output must be polished, natural ${targetLanguage} dialogue.

**Index markers are MANDATORY:** every input [N] must appear exactly once in the output,
in the same order, followed by the refined text for that subtitle.

${outputFormatSection}`;

  let previousRefinedBlockText = '';
  if (previousRefinedBlock && previousRefinedBlock.trim()) {
    previousRefinedBlockText = `# CONTEXT - Previous Refined Block

For continuity and consistency, here's the previous refined block:

${previousRefinedBlock}

`;
  }

  const formatted = subtitleBlocks.map(([idx, text]) => `[${idx}]${text}`).join('\n');
  const glossarySection = glossaryBlock && glossaryBlock.trim() ? `${glossaryBlock}\n` : '';

  const userPrompt = `${previousRefinedBlockText}${glossarySection}# SUBTITLES TO REFINE

${INPUT_TAG_IN}
${formatted}
${INPUT_TAG_OUT}

REMINDER: Output format must be:
${translateTagIn}
[0]refined subtitle 0
[1]refined subtitle 1
${translateTagOut}

Start with ${translateTagIn} and end with ${translateTagOut}. Nothing before or after.

Provide your refined block now:`;

  return { system: systemPrompt.trim(), user: userPrompt.trim() };
}
