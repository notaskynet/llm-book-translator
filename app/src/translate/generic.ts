// Port of src/core/adapters/generic_translator.py: the single translation engine
// for every format. It prepares the adapter, restores the checkpoint, translates
// the pending units (optionally in parallel), commits results in order and
// reconstructs the output.

import { UNIT_VALIDATION_RETRIES } from '../config';
import type { CheckpointStore } from '../checkpoint/types';
import type { FormatAdapter, TranslationUnit } from '../formats/types';
import { RateLimitError } from '../llm/errors';
import type { LLMProvider, LogCallback } from '../llm/types';
import type { PromptOptions } from '../prompts/prompts';
import { buildChunkGlossaryBlock, type GlossaryOptions, type GlossaryRuntimeState } from '../glossary/chunkBlock';
import { cleanTranslatedText } from '../text/postProcess';
import { iterOrderedConcurrent } from './parallel';
import { refineChunk } from './refine';
import { translateChunk } from './request';

export interface TranslationStats {
  totalChunks: number;
  completedChunks: number;
  failedChunks: number;
  unfinishedChunks: number;
  /** Units processed by this run, excluding those restored from the checkpoint. */
  runProcessedChunks: number;
}

export interface TranslationCallbacks {
  onLog?: LogCallback;
  onStats?: (stats: TranslationStats) => void;
  /** Polled before each unit is launched; true stops the run gracefully. */
  shouldInterrupt?: () => boolean;
}

export type JobMode = 'translate' | 'refine';

export interface TranslateJobArgs {
  adapter: FormatAdapter;
  store: CheckpointStore;
  translationId: string;
  provider: LLMProvider;
  /** Original file, persisted with the job so it can be resumed after a reload. */
  fileName: string;
  input: ArrayBuffer;
  sourceLanguage: string;
  targetLanguage: string;
  /** Stored with the job; must not contain API keys. */
  jobConfig?: Record<string, unknown>;
  promptOptions?: PromptOptions;
  /** Terms to keep consistent; the entries matching each chunk are injected into its prompt. */
  glossary?: GlossaryOptions;
  bilingual?: boolean;
  parallelWorkers?: number;
  /**
   * 'refine' polishes a file that is already in the target language: units are refined instead of
   * translated, a unit that cannot be refined keeps its draft, and nothing is retried on validation.
   */
  mode?: JobMode;
  callbacks?: TranslationCallbacks;
}

export type TranslationOutcome =
  | { status: 'completed'; output: Uint8Array; stats: TranslationStats }
  /** Finished, but some units failed; the output keeps the source text for them. */
  | { status: 'partial'; output: Uint8Array; stats: TranslationStats }
  | { status: 'paused'; reason: 'interrupted' | 'rate_limit'; output?: Uint8Array; retryAfter?: number; stats: TranslationStats }
  | { status: 'failed'; error: string; stats: TranslationStats };

/** LLM content that failed adapter validation after every attempt. */
class ValidationFailed {
  constructor(readonly content: string) {}
}

/** The tail of what was just committed, handed to the next unit for continuity. */
function nextContext(mode: JobMode, committed: string, keptDraft: boolean): string {
  if (mode === 'translate') return committed.length > 200 ? committed.slice(-200) : committed;
  if (keptDraft) return '';
  const words = committed.split(/\s+/).filter(Boolean);
  return words.length > 25 ? words.slice(-25).join(' ') : committed;
}

export async function translateJob(args: TranslateJobArgs): Promise<TranslationOutcome> {
  const {
    adapter, store, translationId, provider, sourceLanguage, targetLanguage,
    promptOptions = {}, glossary, bilingual = false, parallelWorkers = 1, mode = 'translate', callbacks = {},
  } = args;
  const refining = mode === 'refine';
  const { onLog: log, onStats, shouldInterrupt } = callbacks;

  const stats: TranslationStats = { totalChunks: 0, completedChunks: 0, failedChunks: 0, unfinishedChunks: 0, runProcessedChunks: 0 };
  const emitStats = (restored: number) => {
    stats.unfinishedChunks = Math.max(0, stats.totalChunks - stats.completedChunks);
    stats.runProcessedChunks = Math.max(0, stats.completedChunks - restored);
    onStats?.({ ...stats });
  };

  try {
    log?.('prepare_start', `Preparing ${adapter.formatName.toUpperCase()} file for translation`);
    if (!(await adapter.prepareForTranslation())) {
      log?.('prepare_failed', 'Failed to prepare file for translation');
      return { status: 'failed', error: 'prepare_failed', stats };
    }

    const units = adapter.getTranslationUnits();
    const total = units.length;
    if (total === 0) {
      log?.('no_units', 'No translation units found in file');
      return { status: 'failed', error: 'no_units', stats };
    }
    log?.('units_found', `Found ${total} translation units`);

    stats.totalChunks = total;
    emitStats(0);

    // Restore the checkpoint. Pending work comes from per-chunk statuses, not a progress
    // pointer: the pointer advances past failed units, so resuming from it would skip
    // them forever (issue #204).
    const restoredCompleted = new Set<number>();
    const checkpoint = await store.loadCheckpoint(translationId);
    if (checkpoint) {
      await adapter.resumeFromCheckpoint(checkpoint.chunks);
      for (const c of checkpoint.chunks) {
        if (c.status === 'completed' && c.chunkIndex >= 0 && c.chunkIndex < total) restoredCompleted.add(c.chunkIndex);
      }
      await store.markRunning(translationId);
      log?.('checkpoint_resumed', `Resuming: ${restoredCompleted.size}/${total} units already translated`);
      stats.completedChunks = restoredCompleted.size;
      emitStats(restoredCompleted.size);
    } else {
      await store.startJob({
        id: translationId,
        fileName: args.fileName,
        fileType: adapter.formatName,
        config: { ...args.jobConfig, sourceLanguage, targetLanguage },
        input: args.input,
        totalChunks: total,
      });
    }
    const restored = restoredCompleted.size;

    // Cap warnings are shown once per job, however many chunks hit the cap.
    const glossaryState: GlossaryRuntimeState = {};
    const buildGlossaryBlock = glossary?.terms.size
      ? (content: string) => buildChunkGlossaryBlock(content, glossary, { log, state: glossaryState, targetLanguage })
      : undefined;

    const workers = Math.max(1, Math.trunc(parallelWorkers));
    const sequential = workers === 1;
    const maxValidationAttempts = 1 + Math.max(0, UNIT_VALIDATION_RETRIES);
    let lastContext = '';
    // Units whose refinement fell back to the draft; the next unit gets no "previous" context then.
    const keptDraft = new Set<number>();

    const refineUnit = async (i: number, signal: AbortSignal): Promise<string> => {
      const unit = units[i];
      log?.('unit_start', `Refining unit ${i + 1}/${total} (${unit.unitId})`);
      const context = {
        provider, sourceLanguage, targetLanguage, promptOptions,
        previousTranslationContext: sequential ? lastContext : '', buildGlossaryBlock, log, signal,
      };
      let refined: string | null;
      if (adapter.refineUnit) {
        refined = await adapter.refineUnit(unit, context);
      } else if (unit.content.trim().length <= 1) {
        refined = unit.content; // nothing worth sending
      } else {
        const text = await refineChunk({
          draft: unit.content, contextBefore: unit.contextBefore, contextAfter: unit.contextAfter,
          previousRefinedContext: context.previousTranslationContext, targetLanguage, provider, promptOptions, buildGlossaryBlock, log, signal,
        });
        refined = text === null ? null : cleanTranslatedText(text);
      }
      if (refined === null) {
        log?.('refinement_chunk_failed', `Refinement failed for unit ${i + 1}, keeping the original`);
        keptDraft.add(i);
        return unit.content;
      }
      return refined;
    };

    const translateUnit = async (i: number, signal: AbortSignal): Promise<string | null | ValidationFailed> => {
      if (refining) return refineUnit(i, signal);
      const unit = units[i];
      log?.('unit_start', `Translating unit ${i + 1}/${total} (${unit.unitId})`);

      const baseInstructions = promptOptions.custom_instructions ?? '';
      let attemptOptions = promptOptions;
      let result: string | null = null;

      for (let attempt = 0; attempt < maxValidationAttempts; attempt++) {
        // Parallel runs have no stable "previous translation".
        const previousTranslationContext = sequential ? lastContext : '';
        if (adapter.translateUnit) {
          result = await adapter.translateUnit(unit, {
            provider, sourceLanguage, targetLanguage, promptOptions: attemptOptions,
            previousTranslationContext, buildGlossaryBlock, log, signal,
          });
        } else {
          ({ translation: result } = await translateChunk({
            mainContent: unit.content,
            contextBefore: unit.contextBefore,
            contextAfter: unit.contextAfter,
            previousTranslationContext,
            sourceLanguage,
            targetLanguage,
            provider,
            promptOptions: attemptOptions,
            buildGlossaryBlock,
            log,
            signal,
          }));
        }
        if (!result) return result; // API failure / empty result

        const feedback = adapter.validateUnitTranslation(unit.unitId, result);
        if (feedback === null) return result;

        log?.('unit_validation_failed', `Unit ${i + 1}/${total}: ${feedback} (attempt ${attempt + 1}/${maxValidationAttempts})`);
        const reinforced = adapter.getValidationRetryInstructions(feedback);
        attemptOptions = {
          ...promptOptions,
          custom_instructions: baseInstructions ? `${baseInstructions}\n\n${reinforced}` : reinforced,
        };
      }

      log?.(
        'unit_validation_exhausted',
        `Unit ${i + 1}/${total} still incomplete after ${maxValidationAttempts} attempts — keeping valid parts and marking the unit failed`,
      );
      return new ValidationFailed(result!);
    };

    const saveCheckpoint = (i: number, unit: TranslationUnit, translated: string | null) =>
      store.saveCheckpoint({
        jobId: translationId,
        chunkIndex: i,
        originalText: unit.content,
        translatedText: translated,
        chunkData: unit.metadata,
        totalChunks: total,
      });

    const recordFailure = async (i: number, unit: TranslationUnit) => {
      log?.('unit_failed', `Failed to translate unit ${i + 1}/${total}`);
      stats.failedChunks += 1;
      await saveCheckpoint(i, unit, null);
      emitStats(restored);
    };

    const partialOutput = async (): Promise<Uint8Array | undefined> => {
      try {
        return await adapter.reconstructOutput({ bilingual });
      } catch (err) {
        log?.('reconstruct_partial_failed', `Could not save partial output: ${String(err)}`);
        return undefined;
      }
    };

    // Everything without a committed translation is (re)translated: units never attempted
    // and units that failed before.
    const pending = units.map((_, i) => i).filter((i) => !restoredCompleted.has(i));
    let remaining = pending.length;
    let nextIndex = pending[0] ?? total;
    let rateLimit: RateLimitError | undefined;

    // Leaving the loop early (break or throw) closes the generator, which cancels
    // the requests still in flight.
    {
      for await (const { item: i, value, error } of iterOrderedConcurrent(pending, workers, translateUnit, shouldInterrupt)) {
        const unit = units[i];

        if (error instanceof RateLimitError) {
          rateLimit = error; // stop before committing so a resume restarts at this unit
          break;
        }
        remaining -= 1;

        if (error !== undefined) {
          log?.('unit_error', `Error translating unit ${i + 1}/${total}: ${error instanceof Error ? error.message : String(error)}`);
          await recordFailure(i, unit);
        } else if (value instanceof ValidationFailed) {
          // Keep whatever parsed so the output stays best-effort, but record the unit as
          // failed: the job ends 'partial' and the unit is fully retranslated on retry.
          await adapter.saveUnitTranslation(unit.unitId, value.content);
          await recordFailure(i, unit);
        } else if (value) {
          if (!(await adapter.saveUnitTranslation(unit.unitId, value))) {
            log?.('save_failed', `Failed to save translation for unit ${unit.unitId}`);
            stats.failedChunks += 1;
          } else {
            stats.completedChunks += 1;
            await saveCheckpoint(i, unit, value);
            emitStats(restored);
            if (sequential) {
              lastContext = adapter.nextContext?.(mode, value) ?? nextContext(mode, value, keptDraft.has(i));
            }
            log?.('unit_complete', `Unit ${i + 1}/${total} translated successfully`);
          }
        } else {
          await recordFailure(i, unit);
        }
        nextIndex = i + 1;
      }
    }

    if (rateLimit) {
      log?.('rate_limited', `Rate limit hit (${rateLimit.provider ?? 'provider'}); pausing so the job can be resumed`);
      const output = await partialOutput();
      await store.markPaused(translationId);
      return { status: 'paused', reason: 'rate_limit', output, retryAfter: rateLimit.retryAfter, stats: { ...stats } };
    }

    // The scheduler stopped early on an interruption request: committed units are
    // persisted, so save the partial output and pause.
    if (remaining > 0 && shouldInterrupt?.()) {
      log?.('translation_interrupted', `Translation interrupted at unit ${nextIndex + 1}/${total}`);
      const output = await partialOutput();
      await store.markPaused(translationId);
      return { status: 'paused', reason: 'interrupted', output, stats: { ...stats } };
    }

    log?.('reconstruct_start', 'Reconstructing output file');
    let output: Uint8Array;
    try {
      output = await adapter.reconstructOutput({ bilingual });
      log?.('reconstruct_complete', 'Output file ready');
    } catch (err) {
      log?.('reconstruct_failed', `Failed to reconstruct output: ${String(err)}`);
      return { status: 'failed', error: 'reconstruct_failed', stats: { ...stats } };
    }

    // Complete only when every unit is genuinely translated; otherwise keep the checkpoint
    // resumable so the failed units can be retried (issue #204).
    if (stats.failedChunks === 0 && stats.completedChunks === total) {
      await store.markCompleted(translationId);
      log?.('translation_complete', `Translation completed successfully: ${total} units`);
      return { status: 'completed', output, stats: { ...stats } };
    }
    await store.markPartial(translationId);
    log?.(
      'translation_partial',
      `Translation completed with ${stats.failedChunks} failures out of ${total} units — checkpoint kept for retry`,
    );
    return { status: 'partial', output, stats: { ...stats } };
  } catch (err) {
    log?.('translation_error', `Translation error: ${err instanceof Error ? err.message : String(err)}`);
    return { status: 'failed', error: err instanceof Error ? err.message : String(err), stats: { ...stats } };
  } finally {
    await adapter.cleanup().catch(() => {});
  }
}
