import { describe, expect, it } from 'vitest';
import reference from './fixtures/python-reference.json';
import { SrtAdapter } from '../src/formats/srt';
import { extractBlockTranslationsWithRemapping } from '../src/formats/srtProcessor';
import { TxtAdapter } from '../src/formats/txt';
import { encodeUtf8, type TranslationUnit } from '../src/formats/types';

const dec = (b: Uint8Array) => new TextDecoder().decode(b);

const unitsOf = (units: TranslationUnit[]) =>
  units.map((u) => ({
    unit_id: u.unitId, content: u.content, context_before: u.contextBefore, context_after: u.contextAfter, metadata: u.metadata,
  }));

describe('TxtAdapter matches the Python adapter', () => {
  for (const c of reference.txt) {
    it(c.name, async () => {
      const adapter = new TxtAdapter(encodeUtf8(c.text), { maxTokensPerChunk: c.max_tokens });
      expect(await adapter.prepareForTranslation()).toBe(true);
      const units = adapter.getTranslationUnits();
      expect(unitsOf(units)).toEqual(c.units);

      for (const u of units) {
        expect(adapter.validateUnitTranslation(u.unitId, 'x')).toBe(c.validation[u.unitId as keyof typeof c.validation]);
      }
      for (const [id, text] of Object.entries(c.translated)) {
        expect(await adapter.saveUnitTranslation(id, text as string)).toBe(true);
      }
      expect(dec(await adapter.reconstructOutput())).toBe(c.output);
      expect(dec(await adapter.reconstructOutput({ bilingual: true }))).toBe(c.bilingual);
    });
  }

  it('restores completed chunks from a checkpoint and ignores failed ones', async () => {
    const c = reference.txt[0];
    const adapter = new TxtAdapter(encodeUtf8(c.text), { maxTokensPerChunk: c.max_tokens });
    await adapter.prepareForTranslation();
    await adapter.resumeFromCheckpoint([
      { chunkIndex: 0, status: 'completed', translatedText: 'ZERO', chunkData: { chunk_index: 0 } },
      { chunkIndex: 1, status: 'failed', translatedText: null, chunkData: { chunk_index: 1 } },
    ]);
    const out = dec(await adapter.reconstructOutput());
    expect(out.startsWith('ZERO')).toBe(true);
    expect(out).toContain(c.units[1].content.trim()); // failed chunk falls back to the source text
  });

  it('rejects a save for an unknown unit', async () => {
    const adapter = new TxtAdapter(encodeUtf8('Hello world.'));
    await adapter.prepareForTranslation();
    expect(await adapter.saveUnitTranslation('chunk_9', 'x')).toBe(false);
    expect(await adapter.saveUnitTranslation('garbage', 'x')).toBe(false);
  });
});

describe('SrtAdapter matches the Python adapter', () => {
  for (const c of reference.srt) {
    it(c.name, async () => {
      const adapter = new SrtAdapter(encodeUtf8(c.content), { linesPerBlock: c.lines_per_block });
      expect(await adapter.prepareForTranslation()).toBe(c.prepared);
      if (!c.prepared) return;

      const units = adapter.getTranslationUnits();
      expect(unitsOf(units)).toEqual(c.units);
      expect(adapter.validateUnitTranslation(units[0].unitId, '[0]only first')).toBe(c.missing_marker_feedback);

      const skip = new Set(c.skip_blocks);
      for (const [i, u] of units.entries()) {
        if (skip.has(i)) continue;
        const fake = u.content
          .split('\n')
          .map((l) => (/^\[\d+\]/.test(l) ? l.replace(/^(\[\d+\])/, '$1TR ') : l.trim() ? `TR ${l}` : l))
          .join('\n');
        expect(adapter.validateUnitTranslation(u.unitId, fake)).toBe(c.validations?.[u.unitId as keyof typeof c.validations]);
        await adapter.saveUnitTranslation(u.unitId, fake);
      }
      expect(dec(await adapter.reconstructOutput())).toBe(c.output);
      expect(dec(await adapter.reconstructOutput({ bilingual: true }))).toBe(c.bilingual);
    });
  }

  it('lists the missing markers in the validation feedback', async () => {
    const adapter = new SrtAdapter(encodeUtf8(reference.srt[0].content), { linesPerBlock: 3 });
    await adapter.prepareForTranslation();
    expect(adapter.validateUnitTranslation('block_0', '[0]a\n[2]c')).toBe('missing subtitle index markers: [1]');
    expect(adapter.validateUnitTranslation('block_0', '[0]a\n[1]b\n[2]c')).toBeNull();
  });

  it('rebuilds translations from a checkpoint', async () => {
    const adapter = new SrtAdapter(encodeUtf8(reference.srt[0].content), { linesPerBlock: 3 });
    await adapter.prepareForTranslation();
    const unit = adapter.getTranslationUnits()[0];
    await adapter.resumeFromCheckpoint([
      { chunkIndex: 0, status: 'completed', translatedText: '[0]Salut\n[1]Ça va ?\n[2]-', chunkData: unit.metadata },
    ]);
    expect(dec(await adapter.reconstructOutput())).toContain('Salut');
  });
});

describe('extractBlockTranslationsWithRemapping matches Python', () => {
  for (const c of reference.srt_remap) {
    it(JSON.stringify(c.text), () => {
      const mapping = new Map(Object.entries(c.mapping).map(([k, v]) => [Number(k), v as number]));
      const got = extractBlockTranslationsWithRemapping(c.text, mapping);
      expect(Object.fromEntries([...got].map(([k, v]) => [String(k), v]))).toEqual(c.result);
    });
  }
});
