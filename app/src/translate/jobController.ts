// Runs translation jobs for the UI: builds the provider and adapter, tracks live
// progress, keeps the screen awake, and exposes stop/resume.

import { create } from 'zustand';
import { checkpointStore, library } from '../checkpoint';
import { termsMap, termsMetadata, type TermMetadata } from '../glossary/models';
import type { JobRecord } from '../checkpoint/types';
import { createAdapter, isSupportedFile, mimeTypeFor, outputFileName, refinedFileName } from '../formats';
import { OpenAICompatibleProvider } from '../llm/provider';
import { useSettings } from '../store/settings';
import { currentOptions, type TranslationOptions } from '../store/translation';
import { translateJob, type JobMode, type TranslationOutcome, type TranslationStats } from './generic';

export interface LogLine {
  id: number;
  event: string;
  detail: string;
}

export interface JobOutput {
  blob: Blob;
  fileName: string;
}

/**
 * What the job was started with. Kept in the job so a resume uses the same instructions and
 * glossary even if the preset was edited or deleted in the meantime.
 */
export interface JobSnapshot {
  customInstructions: string;
  /** The preset's refinement block, used by the polish pass. */
  refinementInstructions: string;
  glossary: { terms: Array<[string, string]>; metadata: TermMetadata } | null;
}

async function takeSnapshot(options: TranslationOptions): Promise<JobSnapshot> {
  const preset = options.presetId ? await library.getPreset(options.presetId) : undefined;
  const glossary = options.glossaryId != null ? await library.getGlossary(options.glossaryId) : undefined;
  return {
    customInstructions: preset?.translation ?? '',
    refinementInstructions: preset?.refinement ?? '',
    glossary: glossary?.terms.length ? { terms: [...termsMap(glossary.terms)], metadata: termsMetadata(glossary.terms) } : null,
  };
}

export type JobPhase = 'idle' | 'running' | 'finished';

interface JobState {
  phase: JobPhase;
  fileName?: string;
  /** What the running (or last) job does. */
  task: JobMode;
  stopRequested: boolean;
  stats?: TranslationStats;
  outcome?: TranslationOutcome;
  output?: JobOutput;
  /** The translation as it was before the polish pass, kept when a pass followed it. */
  draft?: JobOutput;
  logs: LogLine[];
  /** Jobs that can be resumed (paused, partial, or interrupted by a reload). */
  resumable: JobRecord[];
}

const MAX_LOG_LINES = 200;
let logId = 0;
let interrupt = false;
let wakeLock: { release(): Promise<void> } | null = null;

export const useJob = create<JobState>(() => ({
  phase: 'idle',
  task: 'translate',
  stopRequested: false,
  logs: [],
  resumable: [],
}));

const patch = (p: Partial<JobState>) => useJob.setState(p);

async function acquireWakeLock() {
  try {
    wakeLock = (await (navigator as any).wakeLock?.request('screen')) ?? null;
  } catch {
    wakeLock = null; // unsupported, or denied while the tab is hidden
  }
}
async function releaseWakeLock() {
  try { await wakeLock?.release(); } catch { /* already released */ }
  wakeLock = null;
}
const warnBeforeLeaving = (e: BeforeUnloadEvent) => e.preventDefault();

export async function refreshResumable() {
  patch({ resumable: await checkpointStore.listResumable() });
}

interface RunJob {
  id: string;
  fileName: string;
  input: ArrayBuffer;
  options: TranslationOptions;
  snapshot: JobSnapshot;
  mode?: JobMode;
}

interface EngineResult {
  outcome: TranslationOutcome;
  output?: JobOutput;
}

/** One engine run: no UI lifecycle, so a translation and the polish after it can share a session. */
async function runEngine(job: RunJob, onLog: (event: string, detail: string) => void): Promise<EngineResult> {
  const { apiKey, baseUrl, model } = useSettings.getState();
  const { id, fileName, input, options, snapshot } = job;
  const mode = job.mode ?? 'translate';

  const provider = new OpenAICompatibleProvider({ baseUrl, model, apiKeys: apiKey, log: onLog });
  const outcome = await translateJob({
    adapter: createAdapter(fileName, input, {
      maxTokensPerChunk: options.maxTokensPerChunk,
      targetLanguage: options.targetLanguage,
      log: onLog,
    }),
    store: checkpointStore,
    translationId: id,
    provider,
    fileName,
    input,
    mode,
    // A polish works on text already in the target language.
    sourceLanguage: mode === 'refine' ? options.targetLanguage : options.sourceLanguage,
    targetLanguage: options.targetLanguage,
    // Everything needed to resume, but never the API key.
    jobConfig: { ...options, baseUrl, model, snapshot, mode },
    promptOptions: {
      custom_instructions: snapshot.customInstructions,
      refinement_instructions: snapshot.refinementInstructions,
      text_cleanup: options.textCleanup,
    },
    glossary: snapshot.glossary ? { terms: new Map(snapshot.glossary.terms), metadata: snapshot.glossary.metadata } : undefined,
    bilingual: mode === 'translate' && options.bilingual,
    parallelWorkers: options.parallelWorkers,
    callbacks: { onLog, onStats: (stats) => patch({ stats }), shouldInterrupt: () => interrupt },
  });

  const bytes = 'output' in outcome ? outcome.output : undefined;
  const name = mode === 'refine' ? refinedFileName(fileName) : outputFileName(fileName, options.targetLanguage);
  return { outcome, output: bytes ? { blob: new Blob([bytes as BlobPart], { type: mimeTypeFor(fileName) }), fileName: name } : undefined };
}

async function run(job: RunJob) {
  const mode = job.mode ?? 'translate';
  interrupt = false;
  patch({ phase: 'running', task: mode, fileName: job.fileName, stopRequested: false, stats: undefined, outcome: undefined, output: undefined, draft: undefined, logs: [] });
  window.addEventListener('beforeunload', warnBeforeLeaving);
  await acquireWakeLock();

  const onLog = (event: string, detail: string) =>
    useJob.setState((s) => ({ logs: [...s.logs, { id: logId++, event, detail }].slice(-MAX_LOG_LINES) }));

  try {
    const first = await runEngine(job, onLog);
    patch({ phase: 'finished', outcome: first.outcome, stats: first.outcome.stats, output: first.output });

    // Polish pass: runs on the finished translation, as its own resumable job.
    if (mode === 'translate' && job.options.refineAfter && first.outcome.status === 'completed' && first.output && !interrupt) {
      const draft = first.output;
      patch({ phase: 'running', task: 'refine', stats: undefined, outcome: undefined, output: undefined, draft });
      const second = await runEngine(
        { ...job, id: `refine_${Date.now()}`, fileName: draft.fileName, input: await draft.blob.arrayBuffer(), mode: 'refine' },
        onLog,
      );
      // If the polish produced nothing (it failed early), the translation is still the result.
      patch({ phase: 'finished', outcome: second.outcome, stats: second.outcome.stats, output: second.output ?? draft });
    }
  } finally {
    window.removeEventListener('beforeunload', warnBeforeLeaving);
    await releaseWakeLock();
    await refreshResumable().catch(() => {});
  }
}

export async function startJob(file: File): Promise<void> {
  if (!isSupportedFile(file.name)) throw new Error('unsupported');
  const input = await file.arrayBuffer();
  const options = currentOptions();
  // "Polish an existing translation" refines the file as it is; the translate options do not apply.
  const mode: JobMode = options.task === 'refine' ? 'refine' : 'translate';
  await run({
    id: `${mode === 'refine' ? 'refine' : 'job'}_${Date.now()}`, fileName: file.name, input, options,
    snapshot: await takeSnapshot(options), mode,
  });
}

export async function resumeJob(jobId: string): Promise<void> {
  const record = await checkpointStore.getJob(jobId);
  if (!record) return;
  // Resume with the settings the job started with; connection details come from the settings store.
  const { snapshot, mode, ...saved } = record.config as Partial<TranslationOptions> & { snapshot?: JobSnapshot; mode?: JobMode };
  // A resumed polish must not start another polish after it.
  const options = { ...currentOptions(), ...saved, refineAfter: mode === 'refine' ? false : (saved.refineAfter ?? false) };
  await run({
    id: record.id, fileName: record.fileName, input: record.input, options, mode: mode ?? 'translate',
    snapshot: snapshot ?? { customInstructions: '', refinementInstructions: '', glossary: null },
  });
}

export async function discardJob(jobId: string): Promise<void> {
  await checkpointStore.deleteJob(jobId);
  await refreshResumable();
}

/** Graceful stop: no new requests are launched; those in flight finish and are committed. */
export function stopJob(): void {
  interrupt = true;
  patch({ stopRequested: true });
}

export function resetJob(): void {
  patch({ phase: 'idle', outcome: undefined, output: undefined, draft: undefined, stats: undefined, logs: [], fileName: undefined });
}
