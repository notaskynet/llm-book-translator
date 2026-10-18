// Port of translate_chunk_with_fallback (src/core/epub/xhtml_translator.py): translate a
// chunk that carries placeholders, with a three-phase fallback.
//   1. Translate with placeholders, retrying until they validate.
//   2. Token alignment: translate the text WITHOUT placeholders and reinsert them
//      proportionally. Tag positions are approximate but the book stays translated.
//   3. Give up: the chunk stays in the source language and the unit is marked failed.

import { MAX_TRANSLATION_ATTEMPTS } from '../config';
import { ContextOverflowError } from '../llm/errors';
import { generatePostProcessingPrompt } from '../prompts/prompts';
import type { UnitTranslationContext } from '../formats/types';
import { translateChunk } from '../translate/request';
import type { HtmlChunk } from './htmlChunker';
import { isTextFreeChunk, removeAllPlaceholders, validatePlaceholders } from './placeholders';
import { alignAndInsertPlaceholders } from './tokenAlignment';

export type ChunkOutcome = 'translated' | 'token_aligned' | 'text_free' | 'untranslated';

export interface ChunkTranslation {
  /** Translation with chunk-local placeholders, or null when the chunk stayed untranslated. */
  text: string | null;
  outcome: ChunkOutcome;
}

export async function translateEpubChunk(
  chunk: HtmlChunk,
  ctx: UnitTranslationContext,
  maxAttempts = MAX_TRANSLATION_ATTEMPTS,
): Promise<ChunkTranslation> {
  const { provider, sourceLanguage, targetLanguage, promptOptions, buildGlossaryBlock, log, signal } = ctx;

  // Nothing for the LLM to do (pure markup, a separator, a bare number): an empty answer
  // would wipe the body, so pass it through verbatim.
  if (isTextFreeChunk(chunk.text)) {
    log?.('chunk_text_free_skipped', 'Chunk has no translatable text - kept as-is');
    return { text: chunk.text, outcome: 'text_free' };
  }

  const request = (mainContent: string, hasPlaceholders: boolean) =>
    translateChunk({
      mainContent, contextBefore: '', contextAfter: '', previousTranslationContext: '',
      sourceLanguage, targetLanguage, provider, hasPlaceholders, promptOptions, buildGlossaryBlock, log, signal,
    });

  // Phase 1
  const hasPlaceholders = Object.keys(chunk.localTagMap).length > 0;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (attempt > 0) log?.('translation_attempt', `Translation retry attempt ${attempt + 1}/${maxAttempts}`);
    const { translation } = await request(chunk.text, hasPlaceholders);
    if (translation === null) continue;
    if (validatePlaceholders(translation, chunk.localTagMap)) return { text: translation, outcome: 'translated' };
  }

  // Phase 2
  log?.('phase2_warning', `Placeholder validation failed after ${maxAttempts} attempts - using token alignment`);
  const { translation: clean } = await request(removeAllPlaceholders(chunk.text), false);
  if (clean !== null) {
    const aligned = alignAndInsertPlaceholders(chunk.text, clean, Object.keys(chunk.localTagMap));
    if (validatePlaceholders(aligned, chunk.localTagMap)) return { text: aligned, outcome: 'token_aligned' };
    log?.('phase2_validation_failed', 'Token alignment did not produce valid placeholders');
  }

  // Phase 3
  log?.('fallback_untranslated', 'All translation attempts failed - this chunk stays in the source language');
  return { text: null, outcome: 'untranslated' };
}

/**
 * Polishes one chunk that carries placeholders (port of _refine_epub_chunks). The refined text is
 * accepted only if its placeholders still validate; otherwise the chunk keeps its draft. No
 * glossary here, as in the Python version.
 */
export async function refineEpubChunk(chunk: HtmlChunk, ctx: UnitTranslationContext): Promise<string | null> {
  const { provider, targetLanguage, promptOptions, log, signal } = ctx;

  // Pure markup (a cover page): nothing to polish, and an empty answer would wipe the body.
  if (isTextFreeChunk(chunk.text)) return chunk.text;

  const prompt = generatePostProcessingPrompt({
    translatedText: chunk.text,
    targetLanguage,
    additionalInstructions: String(promptOptions.refinement_instructions ?? ''),
    hasPlaceholders: true,
    promptOptions,
  });
  log?.('llm_request', 'Sending refinement request to LLM', { system_prompt: prompt.system, user_prompt: prompt.user });

  let response;
  try {
    response = await provider.generate(prompt.user, { systemPrompt: prompt.system, signal });
  } catch (err) {
    if (err instanceof ContextOverflowError) {
      log?.('epub_refinement_error', 'Refinement context overflow; keeping the draft');
      return null;
    }
    throw err;
  }
  if (!response?.content) return null;
  if (response.outputTruncated) {
    log?.('output_truncated', 'The model hit its output token limit during refinement; keeping the draft');
    return null;
  }

  const refined = provider.extractTranslation(response.content);
  if (!refined) {
    log?.('epub_refinement_fallback', 'Refinement answer could not be read; keeping the draft');
    return null;
  }
  if (Object.keys(chunk.localTagMap).length && !validatePlaceholders(refined, chunk.localTagMap)) {
    log?.('epub_refinement_placeholder_corruption', 'Refinement corrupted the placeholders; keeping the draft');
    return null;
  }
  return refined;
}
