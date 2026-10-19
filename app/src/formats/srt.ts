// Port of src/core/adapters/srt_adapter.py.

import { SRT_LINES_PER_BLOCK } from '../config';
import { RateLimitError } from '../llm/errors';
import { generateSubtitleRefinementBlockPrompt } from '../prompts/prompts';
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
  type UnitTranslationContext,
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

  /**
   * Refines one block: its non-empty cues are renumbered 0..n-1 (empty cues are left out of the
   * prompt), sent in one request, and retried once with the missing markers spelled out. Cues the
   * model skipped keep their draft. Port of refine_subtitle_translations.
   */
  async refineUnit(unit: TranslationUnit, ctx: UnitTranslationContext): Promise<string | null> {
    const toUnitLocal = new Map([...this.localToGlobal(unit)].map(([local, global]) => [global, local]));
    const group = (unit.metadata.block_subtitles as number[]).filter((g) => this.subtitles[g].text.trim());
    if (!group.length) return unit.content;

    const tuples: Array<[number, string]> = group.map((g, i) => [i, this.subtitles[g].text]);
    const localToGlobal = new Map(group.map((g, i) => [i, g]));
    const glossaryBlock = ctx.buildGlossaryBlock?.(tuples.map(([, text]) => text).join('\n')) ?? '';
    const instructions = String(ctx.promptOptions.refinement_instructions ?? '');
    const refined = new Map<number, string>();

    for (let attempt = 0; attempt < 2; attempt++) {
      let extra = instructions;
      if (attempt > 0) {
        const missing = tuples.map(([i]) => i).filter((i) => !refined.has(localToGlobal.get(i)!));
        extra =
          (extra ? `${extra}\n\n` : '') +
          'CRITICAL: Your previous response was incomplete. ' +
          `You MUST output ALL ${tuples.length} indices [0] through [${tuples.length - 1}] in order, ` +
          'each followed by the refined subtitle. ' +
          `Missing indices last time: ${missing.map((i) => `[${i}]`).join(', ')}. Do NOT stop early.`;
        ctx.log?.('srt_refinement_retry', `Retrying block ${unit.unitId}: ${missing.length} subtitles still missing`);
      }

      try {
        const prompt = generateSubtitleRefinementBlockPrompt({
          subtitleBlocks: tuples, previousRefinedBlock: ctx.previousTranslationContext,
          targetLanguage: ctx.targetLanguage, additionalInstructions: extra, glossaryBlock,
        });
        const response = await ctx.provider.generate(prompt.user, { systemPrompt: prompt.system, signal: ctx.signal });
        const text = response?.content ? ctx.provider.extractTranslation(response.content) : null;
        if (text) {
          for (const [g, value] of extractBlockTranslationsWithRemapping(text, localToGlobal)) {
            if (!refined.has(g) && value.trim()) refined.set(g, value);
          }
        }
        if (refined.size === group.length) break;
      } catch (err) {
        // Rate limits and cancellation stop the job; anything else costs this attempt only.
        if (err instanceof RateLimitError || ctx.signal?.aborted || (err instanceof Error && /Abort/.test(err.name))) throw err;
        ctx.log?.('srt_refinement_error', `Block ${unit.unitId} attempt ${attempt + 1}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // Subtitles the model missed keep their draft; the block is complete either way.
    return group
      .map((g) => {
        if (!refined.has(g)) ctx.log?.('srt_refinement_fallback', `Subtitle ${g + 1}: keeping original (block missed this index)`);
        return `[${toUnitLocal.get(g)}]${refined.get(g) ?? this.subtitles[g].text}`;
      })
      .join('\n');
  }

  /** After a refined block: its last five cues, renumbered from 0, as context for the next block. */
  nextContext(mode: 'translate' | 'refine', committed: string): string {
    if (mode !== 'refine') return '';
    const entries: string[] = [];
    for (const line of committed.split('\n')) {
      const m = /^\[(\d+)\](.*)$/.exec(line);
      if (m) entries.push(m[2]);
      else if (entries.length) entries[entries.length - 1] += `\n${line}`;
    }
    return entries.slice(-5).map((text, i) => `[${i}]${text}`).join('\n');
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
