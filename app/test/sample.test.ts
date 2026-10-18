import { describe, expect, it } from 'vitest';
import { DocumentTooSmallError, initialSamples, itemsForIndices, loadSourceUnits, pickRandomUnusedIndex, type SampleItem } from '../src/sample/items';
import { runSample, SAMPLE_CONCURRENCY_CAP, type CellUpdate, type ColumnSetup, type RunContext, type SampleColumn } from '../src/sample/run';
import { buildEpub } from './epubFixture';
import { fakeProvider, response, sourceOf, tagged } from './helpers';

const item = (index: number, text = `Extract ${index}.`): SampleItem => ({
  index, sourceText: text, truncated: false, contextBefore: '', contextAfter: '',
});
const column = (id: string, model = id, presetId: string | null = null, glossaryId: number | null = null): SampleColumn => ({ id, model, presetId, glossaryId });
const plain: ColumnSetup = { promptOptions: {} };

/** A run whose providers are fakes keyed by model name. */
function harness(handler: (model: string, user: string, system: string) => ReturnType<typeof response> | null | Promise<ReturnType<typeof response> | null>) {
  const calls: Array<{ model: string; system: string; user: string }> = [];
  const providers = new Map<string, ReturnType<typeof fakeProvider>>();
  const ctx: RunContext = {
    baseUrl: 'https://llm.test/v1', apiKeys: '', sourceLanguage: 'English', targetLanguage: 'French', mode: 'translate',
    createProvider: (col) => {
      if (!providers.has(col.model)) {
        providers.set(col.model, fakeProvider(async (user, _i, system) => {
          calls.push({ model: col.model, system: system ?? '', user });
          return handler(col.model, user, system ?? '');
        }));
      }
      return providers.get(col.model)!;
    },
  };
  return { ctx, calls, providers };
}

async function run(opts: { items: SampleItem[]; columns: SampleColumn[]; setups?: ColumnSetup[]; ctx: RunContext; only?: { row: number; col: number }[]; signal?: AbortSignal }) {
  const updates: CellUpdate[] = [];
  await runSample({ ...opts, setups: opts.setups ?? opts.columns.map(() => plain), onUpdate: (u) => updates.push(u) });
  const cell = (row: number, col: number, phase: 'translate' | 'refine' = 'translate') =>
    updates.find((u) => u.row === row && u.col === col && u.phase === phase);
  return { updates, cell };
}

describe('building extracts', () => {
  const units = Array.from({ length: 10 }, (_, i) => ({ mainContent: `Unit ${i}. ` + 'Some words here. '.repeat(30), contextBefore: i ? `Unit ${i - 1}.` : '', contextAfter: `Unit ${i + 1}.` }));

  it('samples interior units and caps each extract at a sentence boundary', () => {
    const { items, warning } = initialSamples(units, 3, 100);
    expect(items.map((i) => i.index)).toEqual([2, 4, 7]);
    expect(warning).toBeNull();
    for (const i of items) {
      expect(i.truncated).toBe(true);
      expect(i.sourceText.endsWith('.')).toBe(true);
      expect(i.contextBefore).toBe(`Unit ${i.index - 1}.`);
    }
  });

  it('warns when the document has fewer interior units than requested, and rejects tiny documents', () => {
    expect(initialSamples(units.slice(0, 5), 5, 100).warning).toEqual({ total: 5, count: 3, requested: 5 });
    expect(() => initialSamples(units.slice(0, 2), 3, 100)).toThrow(DocumentTooSmallError);
  });

  it('ignores indices outside the document', () => {
    expect(itemsForIndices(units, [-1, 3, 99], 100).map((i) => i.index)).toEqual([3]);
  });

  it('picks a random unused interior index, never the first or last', () => {
    expect(pickRandomUnusedIndex(5, new Set([1, 2]), () => 0)).toBe(3);
    expect(pickRandomUnusedIndex(5, new Set([1, 2, 3]))).toBeNull();
    expect(pickRandomUnusedIndex(2, new Set())).toBeNull();
    const seen = new Set(Array.from({ length: 200 }, () => pickRandomUnusedIndex(6, new Set())!));
    expect([...seen].sort()).toEqual([1, 2, 3, 4]);
  });

  it('loads units from a text file, an SRT file and an EPUB', async () => {
    const file = (name: string, data: Uint8Array | string) => ({ name, arrayBuffer: async () => (typeof data === 'string' ? new TextEncoder().encode(data) : data).buffer.slice(0) as ArrayBuffer });

    const text = await loadSourceUnits(file('a.txt', Array.from({ length: 12 }, (_, i) => `Paragraph ${i}. ${'The traveller walked on. '.repeat(40)}`).join('\n\n')));
    expect(text.length).toBeGreaterThan(2);
    expect(text[1].contextBefore).not.toBe('');

    const cues = Array.from({ length: 25 }, (_, i) => `${i + 1}\n00:00:${String(i).padStart(2, '0')},000 --> 00:00:${String(i).padStart(2, '0')},500\nLine ${i}`).join('\n\n');
    const srt = await loadSourceUnits(file('a.srt', cues));
    expect(srt).toHaveLength(3); // blocks of 10 cues
    expect(srt[0].mainContent.split('\n')).toHaveLength(10);
    expect(srt[1].contextBefore).toBe(srt[0].mainContent);

    const epub = await loadSourceUnits(file('a.epub', await buildEpub({ paragraphs: 6 })));
    expect(epub.length).toBeGreaterThan(0);
    expect(epub[0].mainContent).toContain('Chapter One');
    expect(epub[0].mainContent).not.toMatch(/<[a-z/]|\[id/); // text only, once (no per-ancestor duplication)
    expect(epub.map((u) => u.mainContent).join(' ').split('Chapter One').length - 1).toBe(1);
  });
});

describe('running the grid', () => {
  it('translates every extract once per column, with the right prompt', async () => {
    const h = harness((model, user) => tagged(`${model}:${sourceOf(user)}`));
    const { updates, cell } = await run({ items: [item(1), item(2)], columns: [column('a'), column('b')], ctx: h.ctx });

    expect(updates).toHaveLength(4);
    expect(cell(1, 1)?.result.output).toBe('b:Extract 2.');
    expect(cell(0, 0)?.result.metrics.lengthRatio).toBeGreaterThan(1);
    expect(h.calls[0].system).toContain('professional French translator');
    expect(h.calls[0].user).not.toContain('Previous Paragraph'); // every cell is independent
  });

  it('refines the extract itself in refine mode', async () => {
    const h = harness((_m, user) => tagged(`POLI ${sourceOf(user)}`));
    const { updates, cell } = await run({ items: [item(1)], columns: [column('a')], ctx: { ...h.ctx, mode: 'refine' } });
    expect(updates.map((u) => u.phase)).toEqual(['refine']);
    expect(h.calls[0].system).toContain('literary editor');
    expect(cell(0, 0, 'refine')?.result.output).toBe('POLI Extract 1.');
  });

  it('refines its own translation in translate+refine mode, and skips the polish of a failed translation', async () => {
    const h = harness((model, user, system) => {
      if (model === 'bad') return null;
      return system.includes('literary editor') ? tagged(`POLI(${sourceOf(user)})`) : tagged(`TRAD(${sourceOf(user)})`);
    });
    const { updates, cell } = await run({ items: [item(1)], columns: [column('good'), column('bad')], ctx: { ...h.ctx, mode: 'translate_refine' } });

    expect(cell(0, 0, 'translate')?.result.output).toBe('TRAD(Extract 1.)');
    expect(cell(0, 0, 'refine')?.result.output).toBe('POLI(TRAD(Extract 1.))'); // the draft is the translation
    expect(cell(0, 1, 'translate')?.result.status).toBe('error');
    expect(cell(0, 1, 'refine')).toBeUndefined();
    expect(updates.filter((u) => u.col === 1)).toHaveLength(1);
  });

  it('records an error in one cell without stopping the others', async () => {
    const h = harness((model, user) => {
      if (model === 'boom') throw new Error('provider exploded');
      return tagged(sourceOf(user));
    });
    const { cell } = await run({ items: [item(1)], columns: [column('boom'), column('ok')], ctx: h.ctx });
    expect(cell(0, 0)?.result).toMatchObject({ status: 'error', output: null, error: 'provider exploded' });
    expect(cell(0, 1)?.result.status).toBe('done');
  });

  it('shows the raw answer, flagged, when the model ignores the tags', async () => {
    const h = harness(() => response('  just text, no tags  '));
    const { cell } = await run({ items: [item(1)], columns: [column('a')], ctx: h.ctx });
    expect(cell(0, 0)?.result).toMatchObject({ status: 'done', output: 'just text, no tags' });
    expect(cell(0, 0)?.result.metrics.wasFallback).toBe(true);
  });

  it('flags a truncated answer and reports token usage', async () => {
    const h = harness(() => response('<TRANSLATION>cut', { outputTruncated: true, promptTokens: 12, completionTokens: 3 }));
    const { cell } = await run({ items: [item(1)], columns: [column('a')], ctx: h.ctx });
    expect(cell(0, 0)?.result.metrics).toMatchObject({ wasTruncated: true, promptTokens: 12, completionTokens: 3 });
  });

  it('applies each column\'s own style and glossary', async () => {
    const h = harness((_m, user) => tagged(sourceOf(user)));
    const setups: ColumnSetup[] = [
      { promptOptions: { custom_instructions: 'Be terse.' } },
      { promptOptions: { custom_instructions: 'Be lyrical.' }, glossary: { terms: new Map([['Extract', 'Passage']]) } },
    ];
    await run({ items: [item(1)], columns: [column('a'), column('b')], setups, ctx: h.ctx });
    const a = h.calls.find((c) => c.model === 'a')!;
    const b = h.calls.find((c) => c.model === 'b')!;
    expect(a.system).toContain('Be terse.');
    expect(a.user).not.toContain('GLOSSARY');
    expect(b.system).toContain('Be lyrical.');
    expect(b.user).toContain('Extract -> Passage');
  });

  it('never has more than the concurrency cap in flight', async () => {
    let active = 0;
    let peak = 0;
    const h = harness(async (_m, user) => {
      peak = Math.max(peak, ++active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      return tagged(sourceOf(user));
    });
    const items = Array.from({ length: 6 }, (_, i) => item(i + 1));
    // One provider per column, so the cap is measured across them through the shared counter.
    const { updates } = await run({ items, columns: [column('a'), column('b'), column('c')], ctx: h.ctx });
    expect(updates).toHaveLength(18);
    expect(peak).toBe(SAMPLE_CONCURRENCY_CAP);
  });

  it('can run a single cell', async () => {
    const h = harness((_m, user) => tagged(sourceOf(user)));
    const { updates } = await run({ items: [item(1), item(2)], columns: [column('a'), column('b')], ctx: h.ctx, only: [{ row: 1, col: 0 }] });
    expect(updates.map((u) => [u.row, u.col])).toEqual([[1, 0]]);
  });

  it('stops launching cells once cancelled', async () => {
    const controller = new AbortController();
    const h = harness(async (_m, user) => {
      controller.abort();
      return tagged(sourceOf(user));
    });
    const items = Array.from({ length: 20 }, (_, i) => item(i + 1));
    const { updates } = await run({ items, columns: [column('a')], ctx: h.ctx, signal: controller.signal });
    expect(updates.length).toBeLessThan(20);
  });
});
