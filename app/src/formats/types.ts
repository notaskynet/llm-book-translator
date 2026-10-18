// Port of src/core/adapters/format_adapter.py and translation_unit.py.

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

export interface FormatAdapter {
  readonly formatName: string;
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
}

export const encodeUtf8 = (s: string): Uint8Array => new TextEncoder().encode(s);
export const decodeUtf8 = (b: ArrayBuffer | Uint8Array): string => new TextDecoder('utf-8').decode(b);

export const GENERIC_RETRY_INSTRUCTIONS = (feedback: string) =>
  `CRITICAL: Your previous response was incomplete (${feedback}). Translate the whole text.`;
