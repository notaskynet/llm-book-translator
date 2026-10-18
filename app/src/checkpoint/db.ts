import Dexie, { type EntityTable, type Table } from 'dexie';
import type { CheckpointStore, ChunkRecord, JobRecord, JobStatus } from './types';

class BookTranslatorDB extends Dexie {
  jobs!: EntityTable<JobRecord, 'id'>;
  chunks!: Table<ChunkRecord, [string, number]>;

  constructor(name = 'llm-book-translator') {
    super(name);
    this.version(1).stores({
      jobs: 'id, status, updatedAt',
      chunks: '[jobId+chunkIndex], jobId',
    });
  }
}
export class DexieCheckpointStore implements CheckpointStore {
  readonly db: BookTranslatorDB;

  constructor(dbName?: string) {
    this.db = new BookTranslatorDB(dbName);
  }

  async loadCheckpoint(jobId: string) {
    const job = await this.db.jobs.get(jobId);
    if (!job) return null;
    const chunks = await this.db.chunks.where('jobId').equals(jobId).sortBy('chunkIndex');
    return {
      chunks: chunks.map(({ chunkIndex, status, translatedText, chunkData }) => ({ chunkIndex, status, translatedText, chunkData })),
    };
  }

  async startJob(job: Omit<JobRecord, 'status' | 'createdAt' | 'updatedAt'>) {
    const now = Date.now();
    await this.db.jobs.put({ ...job, status: 'running', createdAt: now, updatedAt: now });
  }

  async saveCheckpoint(c: Parameters<CheckpointStore['saveCheckpoint']>[0]) {
    const now = Date.now();
    await this.db.transaction('rw', this.db.jobs, this.db.chunks, async () => {
      await this.db.chunks.put({
        jobId: c.jobId,
        chunkIndex: c.chunkIndex,
        status: c.translatedText == null ? 'failed' : 'completed',
        originalText: c.originalText,
        translatedText: c.translatedText,
        chunkData: c.chunkData,
        updatedAt: now,
      });
      await this.db.jobs.update(c.jobId, { totalChunks: c.totalChunks, updatedAt: now });
    });
  }

  private async setStatus(jobId: string, status: JobStatus) {
    await this.db.jobs.update(jobId, { status, updatedAt: Date.now() });
  }

  markRunning = (jobId: string) => this.setStatus(jobId, 'running');
  markPaused = (jobId: string) => this.setStatus(jobId, 'paused');
  markPartial = (jobId: string) => this.setStatus(jobId, 'partial');
  /** A finished job is not resumable, so its input and chunks are dropped to save quota. */
  async markCompleted(jobId: string) {
    await this.db.transaction('rw', this.db.jobs, this.db.chunks, async () => {
      await this.db.chunks.where('jobId').equals(jobId).delete();
      await this.db.jobs.update(jobId, { status: 'completed', input: new ArrayBuffer(0), updatedAt: Date.now() });
    });
  }

  /** Jobs that can still be resumed, most recent first. */
  async listResumable(): Promise<JobRecord[]> {
    const jobs = await this.db.jobs.where('status').anyOf('running', 'paused', 'partial').toArray();
    return jobs.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  getJob(jobId: string) {
    return this.db.jobs.get(jobId);
  }

  async deleteJob(jobId: string) {
    await this.db.transaction('rw', this.db.jobs, this.db.chunks, async () => {
      await this.db.chunks.where('jobId').equals(jobId).delete();
      await this.db.jobs.delete(jobId);
    });
  }

  /** Browsers can kill a tab mid-job; such jobs stay 'running' and are offered for resume. */
  async deleteExpired(maxAgeMs: number) {
    const cutoff = Date.now() - maxAgeMs;
    const old = await this.db.jobs.where('updatedAt').below(cutoff).primaryKeys();
    for (const id of old) await this.deleteJob(id);
  }
}
