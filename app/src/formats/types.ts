// Port of src/core/adapters/format_adapter.py and translation_unit.py.

import type { LLMProvider, LogCallback } from '../llm/types';
import type { PromptOptions } from '../prompts/prompts';

export interface TranslationUnit {
  unitId: string;
  content: string;
  contextBefore: string;
  contextAfter: string;
  metadata: Record<string, unknown>;
}

/** A checkpointed unit as the adapters see it when resuming. */
export interface CheckpointChunk {
  chunkIndex: number;
  status: 'completed' | 'failed';
  translatedText: string | null;
  chunkData: Record<string, unknown>;
}

/** What an adapter's own unit translation needs from the engine. */
export interface UnitTranslationContext {
  provider: LLMProvider;
  sourceLanguage: string;
  targetLanguage: string;
  promptOptions: PromptOptions;
  previousTranslationContext: string;
  /** Glossary block for the text about to be sent (empty when no glossary is active). */
  buildGlossaryBlock?: (content: string) => string;
  log?: LogCallback;
  signal?: AbortSignal;
}

export interface FormatAdapter {
  readonly formatName: string;
  /** Media type of the output file. */
  readonly mimeType?: string;
  /**
   * Formats whose units need more than a plain translation request (EPUB: placeholders and
   * a fallback chain) translate them here. Resolves to null when the unit failed.
   */
  translateUnit?(unit: TranslationUnit, context: UnitTranslationContext): Promise<string | null>;
  /**
   * Formats whose refinement is not a plain request (SRT blocks keep their `[N]` markers, EPUB
   * chunks keep their placeholders) refine units here. Resolves to null to keep the draft.
   */
  refineUnit?(unit: TranslationUnit, context: UnitTranslationContext): Promise<string | null>;
  /** Context handed to the next unit after this one was committed; replaces the engine default. */
  nextContext?(mode: 'translate' | 'refine', committed: string): string;
  /** Parse the input and build the units. Returns false if the file is unusable. */
  prepareForTranslation(): Promise<boolean>;
  getTranslationUnits(): TranslationUnit[];
  /** Null when the translation is acceptable, otherwise feedback for a reinforced retry. */
  validateUnitTranslation(unitId: string, translated: string): string | null;
  getValidationRetryInstructions(feedback: string): string;
  saveUnitTranslation(unitId: string, translated: string): Promise<boolean>;
  reconstructOutput(options?: { bilingual?: boolean }): Promise<Uint8Array>;
  resumeFromCheckpoint(chunks: CheckpointChunk[]): Promise<void>;
  cleanup(): Promise<void>;
}

export interface AdapterConfig {
  maxTokensPerChunk?: number;
  softLimitRatio?: number;
  linesPerBlock?: number;
  /** Used by EPUB to set the document language and localise the TOC. */
  targetLanguage?: string;
  log?: LogCallback;
}

export const encodeUtf8 = (s: string): Uint8Array => new TextEncoder().encode(s);
export const decodeUtf8 = (b: ArrayBuffer | Uint8Array): string => new TextDecoder('utf-8').decode(b);

export const GENERIC_RETRY_INSTRUCTIONS = (feedback: string) =>
  `CRITICAL: Your previous response was incomplete (${feedback}). Translate the whole text.`;
