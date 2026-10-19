// Port of generate_translation_request / _make_llm_request_with_adaptive_context
// (src/core/translator.py). The Ollama-specific adaptive context manager is gone;
// what stays is the behaviour every provider shares: refusal and truncation
// detection, tag extraction with its fallbacks, and shrinking the chunk when the
// model reports a context overflow.

import {
  CHUNK_REDUCTION_FACTOR,
  MAX_CHUNK_REDUCTION_ATTEMPTS,
  MIN_CHUNK_CHARACTERS,
  TRANSLATE_TAG_IN,
  TRANSLATE_TAG_OUT,
} from '../config';
import { ContextOverflowError } from '../llm/errors';
import type { LLMProvider, LLMResponse, LogCallback } from '../llm/types';
import { generateTranslationPrompt, type PromptOptions } from '../prompts/prompts';
import { splitChunkForRetry } from './splitChunk';

export interface TranslateChunkArgs {
  mainContent: string;
  contextBefore: string;
  contextAfter: string;
  previousTranslationContext: string;
  sourceLanguage: string;
  targetLanguage: string;
  provider: LLMProvider;
  hasPlaceholders?: boolean;
  promptOptions?: PromptOptions;
  /** Builds the per-chunk glossary block for the (possibly reduced) content. */
  buildGlossaryBlock?: (content: string) => string;
  log?: LogCallback;
  signal?: AbortSignal;
}

export interface TranslateChunkResult {
  /** The translation, or null when the chunk failed. */
  translation: string | null;
  response: LLMResponse | null;
}

export async function translateChunk(args: TranslateChunkArgs): Promise<TranslateChunkResult> {
  const { mainContent, log } = args;

  // Nothing worth sending to the model.
  if (mainContent.trim().length <= 1) {
    log?.('skip_translation', `Skipping LLM for single/empty character: '${mainContent}'`);
    return { translation: mainContent, response: null };
  }

  const result = await requestWithChunkReduction(args);
  if (result.translation) return result;
  log?.('llm_api_error', 'ERROR: LLM API request failed');
  return { translation: null, response: result.response };
}

async function requestWithChunkReduction(args: TranslateChunkArgs): Promise<TranslateChunkResult> {
  const {
    mainContent, contextBefore, contextAfter, sourceLanguage, targetLanguage,
    provider, hasPlaceholders = false, promptOptions, buildGlossaryBlock, log, signal,
  } = args;
  let previousTranslationContext = args.previousTranslationContext;

  let currentContent = mainContent;
  let remainingContent = '';
  const allTranslations: string[] = [];
  let reductionAttempt = 0;
  let lastResponse: LLMResponse | null = null;
  const fail = (): TranslateChunkResult => ({ translation: null, response: lastResponse });

  while (currentContent.trim()) {
    try {
      const prompt = generateTranslationPrompt({
        mainContent: currentContent,
        contextBefore,
        contextAfter,
        previousTranslationContext,
        sourceLanguage,
        targetLanguage,
        hasPlaceholders,
        promptOptions,
        glossaryBlock: buildGlossaryBlock?.(currentContent) ?? '',
      });

      if (reductionAttempt === 0) {
        log?.('llm_request', 'Sending request to LLM', { system_prompt: prompt.system, user_prompt: prompt.user });
      }

      const started = performance.now();
      const response = await provider.generate(prompt.user, { systemPrompt: prompt.system, signal });
      if (!response) return fail();
      lastResponse = response;

      const raw = response.content;
      if (!raw || !raw.trim()) {
        // Almost always a refusal or provider-side moderation block, not a truncation.
        log?.(
          'empty_llm_response',
          '⚠️ Model returned an empty response (0 tokens). This usually means the model refused or ' +
            'filtered this chunk — common with sensitive/policy-flagged content or provider-side ' +
            'moderation. Try a different model.',
        );
        return fail();
      }

      log?.('llm_response', 'LLM Response received', {
        response: raw,
        execution_time: (performance.now() - started) / 1000,
        tokens: { prompt: response.promptTokens, completion: response.completionTokens, total: response.contextUsed },
      });

      // The model ran out of output tokens: what came back is only the start of the chunk.
      // Saving it would silently drop the rest of the chunk from the book.
      if (response.outputTruncated) {
        log?.(
          'output_truncated',
          `⚠️ The model hit its output token limit before finishing this chunk (finish_reason: ${response.finishReason}). ` +
            'The chunk is marked failed instead of being saved half-translated. If this keeps happening, ' +
            'lower the chunk size or disable reasoning for this model.',
        );
        return fail();
      }

      const translated = provider.extractTranslation(raw);
      if (translated) {
        allTranslations.push(translated);
      } else {
        log?.('translation_extraction_failed', '⚠️ WARNING: Failed to extract translation (tags not found or malformed)');
        log?.('translation_extraction_failed_preview', `Response preview (first 300 chars): ${raw.slice(0, 300)}`);

        const stripped = raw.trim();
        if (stripped.startsWith(TRANSLATE_TAG_IN) && !stripped.endsWith(TRANSLATE_TAG_OUT)) {
          // Cut off mid-translation; the raw fallback below would save the opening tag as content.
          log?.(
            'unclosed_translation_tag',
            '⚠️ Response opened the translation tag but never closed it: the output was cut off. Chunk marked failed.',
          );
          return fail();
        }

        // With placeholders, a raw response would carry the tags into the HTML.
        if (hasPlaceholders) {
          log?.('epub_extraction_critical_fail', 'CRITICAL: Cannot use raw response for EPUB (would corrupt HTML structure)');
          return fail();
        }

        if (!raw.includes(currentContent)) {
          log?.('using_raw_response_fallback', 'Using raw response as fallback (plain text mode)');
          allTranslations.push(raw.trim());
          response.wasFallback = true;
        } else {
          log?.('llm_prompt_in_response_warning', 'WARNING: LLM response seems to contain input. Discarded.');
          return fail();
        }
      }

      if (remainingContent.trim()) {
        currentContent = remainingContent;
        remainingContent = '';
        const words = allTranslations[allTranslations.length - 1].split(/\s+/).filter(Boolean);
        previousTranslationContext = words.length > 25 ? words.slice(-25).join(' ') : allTranslations[allTranslations.length - 1];
        reductionAttempt = 0;
        continue;
      }

      return { translation: allTranslations.join('\n'), response: lastResponse };
    } catch (err) {
      if (!(err instanceof ContextOverflowError)) throw err;

      reductionAttempt += 1;
      if (reductionAttempt > MAX_CHUNK_REDUCTION_ATTEMPTS) {
        log?.(
          'context_overflow_fatal',
          `⚠️ Context overflow: Max reduction attempts (${MAX_CHUNK_REDUCTION_ATTEMPTS}) exceeded. Original error: ${err.message}`,
        );
        return fail();
      }

      const reductionFactor = CHUNK_REDUCTION_FACTOR ** reductionAttempt;
      log?.(
        'context_overflow_retry',
        `⚠️ Context overflow detected! Reducing chunk to ${Math.round(reductionFactor * 100)}% ` +
          `(attempt ${reductionAttempt}/${MAX_CHUNK_REDUCTION_ATTEMPTS})`,
      );

      const [firstPart, secondPart] = splitChunkForRetry(currentContent, reductionFactor);
      if (firstPart.length < MIN_CHUNK_CHARACTERS && !allTranslations.length) {
        log?.('context_overflow_fatal', `⚠️ Cannot reduce chunk further (min size: ${MIN_CHUNK_CHARACTERS} chars)`);
        return fail();
      }

      currentContent = firstPart;
      if (secondPart.trim()) remainingContent = secondPart + (remainingContent ? `\n${remainingContent}` : '');
    }
  }

  return { translation: allTranslations.length ? allTranslations.join('\n') : null, response: lastResponse };
}
