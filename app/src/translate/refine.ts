// Port of _make_refinement_request (src/core/translator.py): one refinement request for a
// plain-text chunk. Refinement is a polish, so a failed chunk keeps its draft; the caller treats
// null as "leave it as it was". Rate limits and cancellation still propagate.

import { ContextOverflowError } from '../llm/errors';
import type { LLMProvider, LogCallback } from '../llm/types';
import { generateRefinementPrompt, type PromptOptions } from '../prompts/prompts';

export interface RefineChunkArgs {
  draft: string;
  contextBefore?: string;
  contextAfter?: string;
  previousRefinedContext: string;
  targetLanguage: string;
  provider: LLMProvider;
  promptOptions?: PromptOptions;
  buildGlossaryBlock?: (content: string) => string;
  log?: LogCallback;
  signal?: AbortSignal;
}

/** The refined text, or null when the chunk should keep its draft. */
export async function refineChunk(args: RefineChunkArgs): Promise<string | null> {
  const { draft, previousRefinedContext, targetLanguage, provider, promptOptions = {}, buildGlossaryBlock, log, signal } = args;

  // The glossary is matched against the draft: terms that survived the first pass are the ones to keep stable.
  const prompt = generateRefinementPrompt({
    draftTranslation: draft,
    previousRefinedContext,
    targetLanguage,
    hasPlaceholders: false,
    promptOptions,
    additionalInstructions: String(promptOptions.refinement_instructions ?? ''),
    glossaryBlock: buildGlossaryBlock?.(draft) ?? '',
  });

  log?.('refinement_request', 'Sending refinement request to LLM', { system_prompt: prompt.system, user_prompt: prompt.user });

  let response;
  try {
    response = await provider.generate(prompt.user, { systemPrompt: prompt.system, signal });
  } catch (err) {
    if (err instanceof ContextOverflowError) {
      log?.('refinement_error', `Refinement context overflow, cannot recover: ${err.message}`);
      return null;
    }
    throw err;
  }
  if (!response) return null;

  // Not in the Python version: a refinement that ran out of output tokens is only the start of the
  // chunk, and saving it would silently drop the rest.
  if (response.outputTruncated) {
    log?.('output_truncated', 'The model hit its output token limit during refinement; keeping the draft');
    return null;
  }

  const raw = response.content;
  const refined = provider.extractTranslation(raw);
  if (refined) return refined;
  if (!raw.includes(draft)) return raw.trim(); // tags missing: use the raw answer
  log?.('refinement_warning', 'Refinement response contains the input. Using the original.');
  return null;
}
