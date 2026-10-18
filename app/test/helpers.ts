import type { CheckpointStore, ChunkRecord, JobRecord, JobStatus } from '../src/checkpoint/types';
import { TranslationExtractor } from '../src/llm/extraction';
import type { GenerateOptions, LLMProvider, LLMResponse } from '../src/llm/types';

export const response = (content: string, extra: Partial<LLMResponse> = {}): LLMResponse => ({
  content, promptTokens: 0, completionTokens: 0, contextUsed: 0, contextLimit: 0,
  wasTruncated: false, wasFallback: false, finishReason: 'stop', outputTruncated: false, ...extra,
});

export const tagged = (text: string) => response(`<TRANSLATION>${text}</TRANSLATION>`);

/** Text between the source tags of a user prompt. */
export const sourceOf = (prompt: string) => /<SOURCE_TEXT>\n([\s\S]*?)\n<\/SOURCE_TEXT>/.exec(prompt)?.[1] ?? '';

export interface FakeProvider extends LLMProvider {
  calls: Array<{ user: string; system?: string }>;
  inFlight: number;
  maxInFlight: number;
}

/** Fake LLM: `handler` maps a request to a response, null (failure), or throws. */
export function fakeProvider(
  handler: (user: string, callIndex: number, system?: string) => LLMResponse | null | Promise<LLMResponse | null>,
): FakeProvider {
  const extractor = new TranslationExtractor();
  const provider: FakeProvider = {
    calls: [],
    inFlight: 0,
    maxInFlight: 0,
    async generate(user: string, options?: GenerateOptions) {
      const index = provider.calls.length;
      provider.calls.push({ user, system: options?.systemPrompt });
      provider.inFlight += 1;
      provider.maxInFlight = Math.max(provider.maxInFlight, provider.inFlight);
      try {
        await Promise.resolve();
        return await handler(user, index, options?.systemPrompt);
      } finally {
        provider.inFlight -= 1;
      }
    },
    extractTranslation: (r) => extractor.extract(r),
  };
  return provider;
}

export class MemoryStore implements CheckpointStore {
  jobs = new Map<string, JobRecord>();
  chunks = new Map<string, ChunkRecord>();
  statusHistory: JobStatus[] = [];

  async loadCheckpoint(jobId: string) {
    if (!this.jobs.has(jobId)) return null;
    const chunks = [...this.chunks.values()].filter((c) => c.jobId === jobId).sort((a, b) => a.chunkIndex - b.chunkIndex);
    return { chunks };
  }
  async startJob(job: Omit<JobRecord, 'status' | 'createdAt' | 'updatedAt'>) {
    this.jobs.set(job.id, { ...job, status: 'running', createdAt: 0, updatedAt: 0 });
  }
  async saveCheckpoint(c: Parameters<CheckpointStore['saveCheckpoint']>[0]) {
    this.chunks.set(`${c.jobId}:${c.chunkIndex}`, {
      jobId: c.jobId, chunkIndex: c.chunkIndex, originalText: c.originalText, translatedText: c.translatedText,
      chunkData: c.chunkData, status: c.translatedText == null ? 'failed' : 'completed', updatedAt: 0,
    });
  }
  private set(id: string, status: JobStatus) {
    this.jobs.get(id)!.status = status;
    this.statusHistory.push(status);
  }
  async markRunning(id: string) { this.set(id, 'running'); }
  async markPaused(id: string) { this.set(id, 'paused'); }
  async markPartial(id: string) { this.set(id, 'partial'); }
  async markCompleted(id: string) { this.set(id, 'completed'); }
}
