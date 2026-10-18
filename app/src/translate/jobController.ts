// Runs translation jobs for the UI: builds the provider and adapter, tracks live
// progress, keeps the screen awake, and exposes stop/resume.

import { create } from 'zustand';
import { checkpointStore } from '../checkpoint';
import type { JobRecord } from '../checkpoint/types';
import { createAdapter, isSupportedFile, outputFileName } from '../formats';
import { OpenAICompatibleProvider } from '../llm/provider';
import { useSettings } from '../store/settings';
import { currentOptions, type TranslationOptions } from '../store/translation';
import { translateJob, type TranslationOutcome, type TranslationStats } from './generic';

export interface LogLine {
  id: number;
  event: string;
  detail: string;
}

export interface JobOutput {
  blob: Blob;
  fileName: string;
}

export type JobPhase = 'idle' | 'running' | 'finished';

interface JobState {
  phase: JobPhase;
  fileName?: string;
  stopRequested: boolean;
  stats?: TranslationStats;
  outcome?: TranslationOutcome;
  output?: JobOutput;
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

async function run(job: {
  id: string;
  fileName: string;
  input: ArrayBuffer;
  options: TranslationOptions;
}) {
  const { apiKey, baseUrl, model } = useSettings.getState();
  const { id, fileName, input, options } = job;

  interrupt = false;
  patch({ phase: 'running', fileName, stopRequested: false, stats: undefined, outcome: undefined, output: undefined, logs: [] });
  window.addEventListener('beforeunload', warnBeforeLeaving);
  await acquireWakeLock();

  const onLog = (event: string, detail: string) =>
    useJob.setState((s) => ({ logs: [...s.logs, { id: logId++, event, detail }].slice(-MAX_LOG_LINES) }));

  try {
    const provider = new OpenAICompatibleProvider({ baseUrl, model, apiKeys: apiKey, log: onLog });
    const outcome = await translateJob({
      adapter: createAdapter(fileName, input, { maxTokensPerChunk: options.maxTokensPerChunk }),
      store: checkpointStore,
      translationId: id,
      provider,
      fileName,
      input,
      sourceLanguage: options.sourceLanguage,
      targetLanguage: options.targetLanguage,
      // Everything needed to resume, but never the API key.
      jobConfig: { ...options, baseUrl, model },
      bilingual: options.bilingual,
      parallelWorkers: options.parallelWorkers,
      callbacks: { onLog, onStats: (stats) => patch({ stats }), shouldInterrupt: () => interrupt },
    });

    const bytes = 'output' in outcome ? outcome.output : undefined;
    patch({
      phase: 'finished',
      outcome,
      stats: outcome.stats,
      output: bytes
        ? { blob: new Blob([bytes as BlobPart], { type: 'text/plain;charset=utf-8' }), fileName: outputFileName(fileName, options.targetLanguage) }
        : undefined,
    });
  } finally {
    window.removeEventListener('beforeunload', warnBeforeLeaving);
    await releaseWakeLock();
    await refreshResumable().catch(() => {});
  }
}

export async function startJob(file: File): Promise<void> {
  if (!isSupportedFile(file.name)) throw new Error('unsupported');
  const input = await file.arrayBuffer();
  await run({ id: `job_${Date.now()}`, fileName: file.name, input, options: currentOptions() });
}

export async function resumeJob(jobId: string): Promise<void> {
  const record = await checkpointStore.getJob(jobId);
  if (!record) return;
  // Resume with the settings the job started with; connection details come from the settings store.
  const saved = record.config as Partial<TranslationOptions>;
  const options = { ...currentOptions(), ...saved };
  await run({ id: record.id, fileName: record.fileName, input: record.input, options });
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
  patch({ phase: 'idle', outcome: undefined, output: undefined, stats: undefined, logs: [], fileName: undefined });
}
