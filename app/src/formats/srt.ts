// Port of src/core/adapters/srt_adapter.py.

import { SRT_LINES_PER_BLOCK } from '../config';
import {
  extractBlockTranslationsWithRemapping,
  groupSubtitlesForTranslation,
  parseSrt,
  reconstructSrt,
  type Subtitle,
} from './srtProcessor';
import {
  decodeUtf8,
  encodeUtf8,
  type AdapterConfig,
  type CheckpointChunk,
  type FormatAdapter,
  type TranslationUnit,
} from './types';

export class SrtAdapter implements FormatAdapter {
  readonly formatName = 'srt';
  private subtitles: Subtitle[] = [];
  private blocks: Subtitle[][] = [];
  private translations = new Map<number, string>();
  private units?: TranslationUnit[];

  constructor(
    private readonly input: ArrayBuffer | Uint8Array,
    private readonly config: AdapterConfig = {},
  ) {}

  async prepareForTranslation(): Promise<boolean> {
    try {
      this.subtitles = parseSrt(decodeUtf8(this.input));
      if (!this.subtitles.length) return false;
      this.blocks = groupSubtitlesForTranslation(
        this.subtitles,
        this.config.linesPerBlock || SRT_LINES_PER_BLOCK,
        10 ** 12, // fixed-count grouping, no character cap
      );
      this.units = undefined;
      return true;
    } catch {
      return false;
    }
  }

  getTranslationUnits(): TranslationUnit[] {
    if (this.units) return this.units;

    const globalOf = new Map(this.subtitles.map((s, i) => [s, i]));
    this.units = this.blocks.map((block, blockIdx) => {
      const localToGlobal: Record<number, number> = {};
      const lines = block.map((subtitle, localIdx) => {
        localToGlobal[localIdx] = globalOf.get(subtitle)!;
        return `[${localIdx}]${subtitle.text}`;
      });
      return {
        unitId: `block_${blockIdx}`,
        content: lines.join('\n'),
        contextBefore: blockIdx > 0 ? this.blocks[blockIdx - 1].at(-1)!.text : '',
        contextAfter: blockIdx < this.blocks.length - 1 ? this.blocks[blockIdx + 1][0].text : '',
        metadata: {
          block_index: blockIdx,
          local_to_global: localToGlobal,
          block_subtitles: block.map((s) => globalOf.get(s)!),
        },
      };
    });
    return this.units;
  }

  private localToGlobal(unit: TranslationUnit): Map<number, number> {
    const raw = unit.metadata.local_to_global as Record<string, number>;
    return new Map(Object.entries(raw).map(([k, v]) => [Number(k), v]));
  }

  /** Requires the `[N]` marker of every cue that has source text. */
  validateUnitTranslation(unitId: string, translated: string): string | null {
    const unit = this.getTranslationUnits()[Number.parseInt(unitId.split('_')[1], 10)];
    if (!unit) return null;

    const expected = [...this.localToGlobal(unit)]
      .filter(([, global]) => this.subtitles[global].text.trim())
      .map(([local]) => local);
    const found = new Set([...translated.matchAll(/\[(\d+)\]/g)].map((m) => Number.parseInt(m[1], 10)));
    const missing = expected.filter((n) => !found.has(n)).sort((a, b) => a - b);
    return missing.length ? `missing subtitle index markers: ${missing.map((n) => `[${n}]`).join(', ')}` : null;
  }

  getValidationRetryInstructions(feedback: string): string {
    return (
      `CRITICAL: Your previous response was structurally incomplete (${feedback}). ` +
      'You MUST reproduce every [N] index marker from the input exactly once, in order, ' +
      'each followed by its translation. Do NOT merge, drop or renumber markers.'
    );
  }

  async saveUnitTranslation(unitId: string, translated: string): Promise<boolean> {
    try {
      const unit = this.getTranslationUnits()[Number.parseInt(unitId.split('_')[1], 10)];
      if (!unit) return false;
      for (const [k, v] of extractBlockTranslationsWithRemapping(translated, this.localToGlobal(unit))) {
        this.translations.set(k, v);
      }
      return true;
    } catch {
      return false;
    }
  }

  async reconstructOutput({ bilingual = false } = {}): Promise<Uint8Array> {
    if (bilingual) {
      const blocks = this.subtitles.map((s, idx) => {
        const translated = this.translations.get(idx) ?? s.originalText;
        return `${s.number}\n${s.startTime} --> ${s.endTime}\n${s.originalText}\n${translated}\n`;
      });
      return encodeUtf8(blocks.join('\n'));
    }
    const updated = this.subtitles.map((s, idx) => (this.translations.has(idx) ? { ...s, text: this.translations.get(idx)! } : s));
    return encodeUtf8(reconstructSrt(updated));
  }

  async resumeFromCheckpoint(chunks: CheckpointChunk[]): Promise<void> {
    for (const c of chunks) {
      const mapping = c.chunkData.local_to_global as Record<string, number> | undefined;
      if (c.status !== 'completed' || !c.translatedText || !mapping) continue;
      const localToGlobal = new Map(Object.entries(mapping).map(([k, v]) => [Number(k), v]));
      for (const [k, v] of extractBlockTranslationsWithRemapping(c.translatedText, localToGlobal)) {
        this.translations.set(k, v);
      }
    }
  }

  async cleanup(): Promise<void> {}
}
