// Running Sample & Compare cells (port of _execute_cell and _run_sample_async in
// src/api/blueprints/sample_routes.py). Every extract is translated, refined, or both, once per
// LLM configuration, without retries or chunk splitting: the point is to compare raw output.

import { buildChunkGlossaryBlock, type GlossaryOptions } from '../glossary/chunkBlock';
import { OpenAICompatibleProvider } from '../llm/provider';
import { generateRefinementPrompt, generateTranslationPrompt, type PromptOptions, type PromptPair } from '../prompts/prompts';
import { iterOrderedConcurrent } from '../translate/parallel';
import type { SampleItem } from './items';

/** Never more than this many requests at once, however large the grid. */
export const SAMPLE_CONCURRENCY_CAP = 8;

export type SampleMode = 'translate' | 'refine' | 'translate_refine';
export type CellPhase = 'translate' | 'refine';

export interface SampleColumn {
  id: string;
  model: string;
  presetId: string | null;
  glossaryId: number | null;
}

/** What a column contributes to the prompts, resolved once per run. */
export interface ColumnSetup {
  promptOptions: PromptOptions;
  glossary?: GlossaryOptions;
}

export interface CellMetrics {
  latencyMs: number;
  promptTokens?: number;
  completionTokens?: number;
  /** Output length relative to the text it was produced from. */
  lengthRatio?: number;
  wasFallback?: boolean;
  wasTruncated?: boolean;
}

export interface CellResult {
  status: 'done' | 'error';
  output: string | null;
  metrics: CellMetrics;
  error?: string;
}

export interface RunContext {
  baseUrl: string;
  apiKeys: string;
  sourceLanguage: string;
  targetLanguage: string;
  mode: SampleMode;
  /** For tests: builds the provider of a column. */
  createProvider?: (column: SampleColumn) => ProviderLike;
}

type ProviderLike = Pick<OpenAICompatibleProvider, 'generate' | 'extractTranslation'>;

const defaultProvider = (ctx: RunContext, column: SampleColumn): ProviderLike =>
  new OpenAICompatibleProvider({ baseUrl: ctx.baseUrl, model: column.model, apiKeys: ctx.apiKeys });

async function executeCell(provider: ProviderLike, prompt: PromptPair, referenceText: string, signal?: AbortSignal): Promise<CellResult> {
  const started = performance.now();
  try {
    const response = await provider.generate(prompt.user, { systemPrompt: prompt.system, signal });
    const latencyMs = Math.round(performance.now() - started);
    if (!response?.content) return { status: 'error', output: null, metrics: { latencyMs }, error: 'The model returned an empty response' };

    // Use the tagged answer; if the tags are missing the raw answer is shown, flagged as a fallback.
    let output = provider.extractTranslation(response.content);
    let wasFallback = response.wasFallback;
    if (output === null || !output.trim()) {
      output = response.content;
      wasFallback = true;
    }
    output = output.trim();
    return {
      status: 'done',
      output,
      metrics: {
        latencyMs,
        promptTokens: response.promptTokens,
        completionTokens: response.completionTokens,
        lengthRatio: Math.round((output.length / Math.max(1, referenceText.length)) * 1000) / 1000,
        wasFallback,
        wasTruncated: response.wasTruncated || response.outputTruncated,
      },
    };
  } catch (err) {
    if (signal?.aborted) throw err;
    return { status: 'error', output: null, metrics: { latencyMs: Math.round(performance.now() - started) }, error: err instanceof Error ? err.message : String(err) };
  }
}

function glossaryBlockFor(setup: ColumnSetup, text: string, targetLanguage: string): string {
  return buildChunkGlossaryBlock(text, setup.glossary, { targetLanguage });
}

/** Runs one phase of one cell. */
export async function runCell(
  phase: CellPhase,
  item: SampleItem,
  draft: string | null,
  column: SampleColumn,
  setup: ColumnSetup,
  ctx: RunContext,
  signal?: AbortSignal,
): Promise<CellResult> {
  const provider = (ctx.createProvider ?? ((c: SampleColumn) => defaultProvider(ctx, c)))(column);

  if (phase === 'translate') {
    const prompt = generateTranslationPrompt({
      mainContent: item.sourceText, contextBefore: item.contextBefore, contextAfter: item.contextAfter,
      previousTranslationContext: '', sourceLanguage: ctx.sourceLanguage, targetLanguage: ctx.targetLanguage,
      hasPlaceholders: false, promptOptions: setup.promptOptions,
      glossaryBlock: glossaryBlockFor(setup, item.sourceText, ctx.targetLanguage),
    });
    return executeCell(provider, prompt, item.sourceText, signal);
  }

  // Refine: the draft is the translation, or in refine-only mode the extract itself.
  const text = draft ?? item.sourceText;
  const prompt = generateRefinementPrompt({
    draftTranslation: text, contextBefore: item.contextBefore, contextAfter: item.contextAfter,
    previousRefinedContext: '', targetLanguage: ctx.targetLanguage, hasPlaceholders: false,
    promptOptions: setup.promptOptions, additionalInstructions: String(setup.promptOptions.refinement_instructions ?? ''),
    glossaryBlock: glossaryBlockFor(setup, text, ctx.targetLanguage),
  });
  return executeCell(provider, prompt, text, signal);
}

export interface CellKey { row: number; col: number }
export interface CellUpdate extends CellKey { phase: CellPhase; result: CellResult }

/**
 * Runs every cell of the grid (or only `only`). In translate+refine mode a cell refines its own
 * translation once that succeeded. Results are reported as they arrive; `signal` stops the run.
 */
export async function runSample(options: {
  items: SampleItem[];
  columns: SampleColumn[];
  setups: ColumnSetup[];
  ctx: RunContext;
  only?: CellKey[];
  signal?: AbortSignal;
  onUpdate: (update: CellUpdate) => void;
}): Promise<void> {
  const { items, columns, setups, ctx, signal, onUpdate } = options;
  const cells = options.only ?? items.flatMap((_, row) => columns.map((__, col) => ({ row, col })));
  const limit = Math.min(SAMPLE_CONCURRENCY_CAP, Math.max(1, cells.length));

  const runOne = async ({ row, col }: CellKey, innerSignal: AbortSignal) => {
    const item = items[row];
    const column = columns[col];
    const cancelled = () => Boolean(signal?.aborted || innerSignal.aborted);
    if (cancelled()) return;

    let draft: string | null = null;
    if (ctx.mode !== 'refine') {
      const result = await runCell('translate', item, null, column, setups[col], ctx, innerSignal);
      onUpdate({ row, col, phase: 'translate', result });
      draft = result.output;
      if (ctx.mode === 'translate_refine' && !draft) return; // nothing to polish
    }
    if (ctx.mode !== 'translate' && !cancelled()) {
      onUpdate({ row, col, phase: 'refine', result: await runCell('refine', item, draft, column, setups[col], ctx, innerSignal) });
    }
  };

  // Up to `limit` cells in flight; stopping the iteration (or aborting `signal`) cancels the rest.
  const stream = iterOrderedConcurrent(cells, limit, runOne, () => Boolean(signal?.aborted));
  for await (const { error } of stream) {
    if (error !== undefined && !signal?.aborted) throw error; // cancellation is not an error
  }
}
