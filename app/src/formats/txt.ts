// Port of src/core/adapters/txt_adapter.py and the join logic in
// src/core/chunking/reassembly.py.

import {
  DEFAULT_MAX_TOKENS_PER_CHUNK,
  MIN_TOKENS_FOR_LENGTH_CHECK,
  MIN_TRANSLATION_LENGTH_RATIO,
  SOFT_LIMIT_RATIO,
} from '../config';
import { countTokens, initTokenizer, TokenChunker, type Chunk } from '../chunking/tokenChunker';
import {
  decodeUtf8,
  encodeUtf8,
  GENERIC_RETRY_INSTRUCTIONS,
  type AdapterConfig,
  type CheckpointChunk,
  type FormatAdapter,
  type TranslationUnit,
} from './types';

const DEFAULT_JOINER = '\n\n';

/**
 * Joins per-chunk output on the separator each chunk was split on, so paragraph
 * breaks survive chunk seams and a sentence-level split inside a paragraph does
 * not become a new paragraph.
 */
export function joinTranslatedChunks(
  parts: Array<string | null>,
  chunks: Array<Pick<Chunk, 'joinWith'>>,
  fallbacks: string[] = [],
): string {
  let out = '';
  parts.forEach((part, i) => {
    const text = (part || fallbacks[i] || '').trim();
    if (i > 0) out += (i < chunks.length && chunks[i].joinWith) || DEFAULT_JOINER;
    out += text;
  });
  return out;
}

export class TxtAdapter implements FormatAdapter {
  readonly formatName: string = 'txt';
  private chunks: Chunk[] = [];
  private translated: Array<string | null> = [];

  constructor(
    protected readonly input: ArrayBuffer | Uint8Array,
    protected readonly config: AdapterConfig = {},
  ) {}

  /** The text to translate; subclasses whose input is not UTF-8 text override this. */
  protected async loadText(): Promise<string> {
    return decodeUtf8(this.input);
  }

  async prepareForTranslation(): Promise<boolean> {
    try {
      await initTokenizer();
      const text = await this.loadText();
      const chunker = new TokenChunker(
        this.config.maxTokensPerChunk ?? DEFAULT_MAX_TOKENS_PER_CHUNK,
        this.config.softLimitRatio ?? SOFT_LIMIT_RATIO,
      );
      this.chunks = chunker.chunkText(text);
      this.translated = this.chunks.map(() => null);
      return true;
    } catch {
      return false;
    }
  }

  getTranslationUnits(): TranslationUnit[] {
    return this.chunks.map((chunk, i) => ({
      unitId: `chunk_${i}`,
      content: chunk.mainContent,
      contextBefore: chunk.contextBefore,
      contextAfter: chunk.contextAfter,
      metadata: { chunk_index: i, total_chunks: this.chunks.length },
    }));
  }

  /** Flags a translation far shorter than its source: the model probably skipped text. */
  validateUnitTranslation(unitId: string, translated: string): string | null {
    if (MIN_TRANSLATION_LENGTH_RATIO <= 0) return null;
    const index = Number.parseInt(unitId.split('_')[1], 10);
    const source = this.chunks[index]?.mainContent;
    if (source === undefined) return null;

    const sourceTokens = countTokens(source);
    if (sourceTokens < MIN_TOKENS_FOR_LENGTH_CHECK) return null;
    const translatedTokens = countTokens(translated);
    if (translatedTokens < sourceTokens * MIN_TRANSLATION_LENGTH_RATIO) {
      return (
        `the translation has ${translatedTokens} tokens for ${sourceTokens} source tokens, ` +
        'so part of the text was probably skipped'
      );
    }
    return null;
  }

  getValidationRetryInstructions(feedback: string): string {
    return GENERIC_RETRY_INSTRUCTIONS(feedback);
  }

  async saveUnitTranslation(unitId: string, translated: string): Promise<boolean> {
    const index = Number.parseInt(unitId.split('_')[1], 10);
    if (Number.isNaN(index) || index < 0 || index >= this.translated.length) return false;
    this.translated[index] = translated;
    return true;
  }

  async reconstructOutput({ bilingual = false } = {}): Promise<Uint8Array> {
    if (!bilingual) {
      return encodeUtf8(
        joinTranslatedChunks(this.translated, this.chunks, this.chunks.map((c) => c.mainContent)),
      );
    }

    const separator = '─'.repeat(40);
    const blocks = this.translated.map((t, i) => {
      const original = this.chunks[i].mainContent.trim();
      const translated = t ? t.trim() : original;
      return `${original}\n\n${translated}\n\n${separator}`;
    });
    let text = blocks.join('\n\n');
    if (text.endsWith(separator)) text = text.slice(0, text.length - separator.length).trimEnd();
    return encodeUtf8(text);
  }

  async resumeFromCheckpoint(chunks: CheckpointChunk[]): Promise<void> {
    for (const c of chunks) {
      if (c.status !== 'completed' || c.translatedText == null) continue;
      const index = (c.chunkData.chunk_index as number | undefined) ?? c.chunkIndex;
      if (index >= 0 && index < this.translated.length) this.translated[index] = c.translatedText;
    }
  }

  async cleanup(): Promise<void> {}
}
