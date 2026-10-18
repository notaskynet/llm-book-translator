import type { CheckpointChunk } from '../formats/types';

export type JobStatus = 'running' | 'paused' | 'partial' | 'completed';

export interface JobRecord {
  id: string;
  status: JobStatus;
  fileName: string;
  fileType: string;
  /** Job settings. Never contains API keys. */
  config: Record<string, unknown>;
  /** Raw input file, kept so a paused or partial job can be resumed after a reload. */
  input: ArrayBuffer;
  totalChunks: number;
  createdAt: number;
  updatedAt: number;
}

export interface ChunkRecord extends CheckpointChunk {
  jobId: string;
  originalText: string;
  updatedAt: number;
}

/** Persistence the translation pipeline needs; the Dexie store is one implementation. */
export interface CheckpointStore {
  loadCheckpoint(jobId: string): Promise<{ chunks: CheckpointChunk[] } | null>;
  startJob(job: Omit<JobRecord, 'status' | 'createdAt' | 'updatedAt'>): Promise<void>;
  saveCheckpoint(chunk: {
    jobId: string;
    chunkIndex: number;
    originalText: string;
    translatedText: string | null;
    chunkData: Record<string, unknown>;
    totalChunks: number;
  }): Promise<void>;
  markRunning(jobId: string): Promise<void>;
  markPaused(jobId: string): Promise<void>;
  markPartial(jobId: string): Promise<void>;
  markCompleted(jobId: string): Promise<void>;
}
