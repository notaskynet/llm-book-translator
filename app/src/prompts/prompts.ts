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
