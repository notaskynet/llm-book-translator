import { describe, expect, it } from 'vitest';
import { EpubAdapter } from '../src/epub/adapter';
import { SrtAdapter } from '../src/formats/srt';
import { TxtAdapter } from '../src/formats/txt';
import { encodeUtf8 } from '../src/formats/types';
import { RateLimitError } from '../src/llm/errors';
import { translateJob, type TranslateJobArgs } from '../src/translate/generic';
import { buildEpub, parseXmlDoc, readEpub } from './epubFixture';
import { fakeProvider, MemoryStore, response, sourceOf, tagged } from './helpers';

const dec = (b?: Uint8Array) => new TextDecoder().decode(b);
const buf = (u: Uint8Array) => u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) as ArrayBuffer;

async function refine(adapter: TranslateJobArgs['adapter'], input: Uint8Array, over: Omit<Partial<TranslateJobArgs>, 'provider'> & { provider: ReturnType<typeof fakeProvider> }) {
  const store = over.store ?? new MemoryStore();
  const logs: string[] = [];
  const outcome = await translateJob({
    adapter, store, translationId: 'r1', fileName: 'book', input: buf(input), sourceLanguage: 'French', targetLanguage: 'French',
    mode: 'refine', callbacks: { onLog: (e) => logs.push(e) }, ...over,
  });
  return { outcome, store, logs };
}

const bytes = (o: Awaited<ReturnType<typeof refine>>['outcome']) => ('output' in o && o.output ? o.output : new Uint8Array());
const out = (o: Awaited<ReturnType<typeof refine>>['outcome']) => dec(bytes(o));

const sentence = 'Le voyageur marchait lentement le long de la vieille route. ';
const book = Array.from({ length: 12 }, (_, i) => `Paragraphe ${i}. ${sentence.repeat(8)}`).join('\n\n');
const txt = (maxTokens = 300) => ({ input: encodeUtf8(book), adapter: new TxtAdapter(encodeUtf8(book), { maxTokensPerChunk: maxTokens }) });

describe('refine mode (TXT)', () => {
  it('refines every chunk, cleans the text, and chains the previous refined words', async () => {
    const provider = fakeProvider((u) => tagged(`POLI ${sourceOf(u).slice(0, 20)} , fin !`));
    const { input, adapter } = txt();
    const { outcome } = await refine(adapter, input, { provider });

    expect(outcome.status).toBe('completed');
    expect(provider.calls.length).toBeGreaterThan(2);
    expect(out(outcome)).toContain(`POLI ${sourceOf(provider.calls[0].user).slice(0, 20)}, fin!`); // space before punctuation removed
    // The prompt is the refinement one, with the previous refined text (last 25 words) as context.
    expect(provider.calls[0].system).toContain('elite French literary editor');
    expect(provider.calls[0].user).not.toContain('Previous Refined');
    expect(provider.calls[1].user).toContain('# CONTEXT - Previous Refined Paragraph');
    expect(provider.calls[1].user).toContain('fin!');
  });

  it('keeps the draft of a chunk it cannot refine and still completes', async () => {
    const provider = fakeProvider((u, i) => (i === 1 ? null : tagged(`POLI ${sourceOf(u).slice(0, 20)}`)));
    const { input, adapter } = txt();
    const { outcome, logs } = await refine(adapter, input, { provider });

    expect(outcome.status).toBe('completed'); // a polish that fails is not a failed job
    expect(logs).toContain('refinement_chunk_failed');
    expect(out(outcome)).toContain(sourceOf(provider.calls[1].user).trim()); // the draft survives
    // The chunk after a failure gets no "previous" context.
    expect(provider.calls[2].user).not.toContain('Previous Refined');
  });

  it('keeps the draft when the model ran out of output tokens', async () => {
    const provider = fakeProvider(() => response('<TRANSLATION>cut', { outputTruncated: true, finishReason: 'length' }));
    const { input, adapter } = txt();
    const { outcome, logs } = await refine(adapter, input, { provider });
    expect(outcome.status).toBe('completed');
    expect(logs).toContain('output_truncated');
    expect(out(outcome)).not.toContain('cut');
    expect(out(outcome)).toContain('Paragraphe 11.');
  });

  it('uses the answer as it is when the tags are missing, unless it just repeats the draft', async () => {
    const provider = fakeProvider((u, i) => (i === 0 ? response(`raw ${sourceOf(u).slice(0, 15)}`) : response(`Voici : ${sourceOf(u)}`)));
    const { input, adapter } = txt();
    const { outcome, logs } = await refine(adapter, input, { provider });
    expect(out(outcome)).toContain('raw Paragraphe 0.');
    expect(logs).toContain('refinement_warning'); // later answers echoed the draft and were discarded
  });

  it('adds the glossary (matched on the draft) and the preset refinement instructions', async () => {
    const provider = fakeProvider((u) => tagged(sourceOf(u)));
    const { input, adapter } = txt();
    await refine(adapter, input, {
      provider,
      glossary: { terms: new Map([['Paragraphe 3', 'Section 3']]) },
      promptOptions: { refinement_instructions: 'Keep a formal tone.' },
    });
    expect(provider.calls.every((c) => c.system?.includes('# ADDITIONAL REFINEMENT INSTRUCTIONS') && c.system.includes('Keep a formal tone.'))).toBe(true);
    const withTerm = provider.calls.filter((c) => sourceOf(c.user).includes('Paragraphe 3.'));
    expect(withTerm.length).toBeGreaterThan(0);
    for (const c of withTerm) expect(c.user).toContain('Paragraphe 3 -> Section 3');
  });

  it('pauses on a rate limit and resumes without refining twice', async () => {
    const store = new MemoryStore();
    const first = fakeProvider((u, i) => {
      if (i === 2) throw new RateLimitError('slow down', 10, 'openai');
      return tagged(`POLI ${sourceOf(u).slice(0, 12)}`);
    });
    const a = txt();
    const paused = await refine(a.adapter, a.input, { provider: first, store });
    expect(paused.outcome).toMatchObject({ status: 'paused', reason: 'rate_limit' });

    const second = fakeProvider((u) => tagged(`POLI ${sourceOf(u).slice(0, 12)}`));
    const b = txt();
    const resumed = await refine(b.adapter, b.input, { provider: second, store });
    expect(resumed.outcome.status).toBe('completed');
    // Nothing the first run committed is refined again.
    const committed = first.calls.slice(0, 2).map((c) => sourceOf(c.user));
    for (const source of second.calls.map((c) => sourceOf(c.user))) expect(committed).not.toContain(source);
    expect(2 + second.calls.length).toBeGreaterThan(2);
  });
});

const srt = () => encodeUtf8(`1
00:00:01,000 --> 00:00:03,000
Bonjour là.

2
00:00:03,500 --> 00:00:05,000
Ça va bien ?

3
00:00:06,000 --> 00:00:08,000
Très bien.
`);

describe('refine mode (SRT)', () => {
  const adapter = (lines = 10) => new SrtAdapter(srt(), { linesPerBlock: lines });

  it('sends the cues with local markers, keeps timecodes and replaces the text', async () => {
    const provider = fakeProvider(() => tagged('[0]Salut !\n[1]Ça roule ?\n[2]Parfait.'));
    const { outcome } = await refine(adapter(), srt(), { provider });
    expect(outcome.status).toBe('completed');

    expect(provider.calls[0].user).toContain('[0]Bonjour là.\n[1]Ça va bien ?\n[2]Très bien.');
    expect(provider.calls[0].system).toContain('elite French subtitle editor');
    const text = out(outcome);
    expect(text).toContain('00:00:01,000 --> 00:00:03,000\nSalut !');
    expect(text).toContain('00:00:03,500 --> 00:00:05,000\nÇa roule ?');
    expect(text).toContain('00:00:06,000 --> 00:00:08,000\nParfait.');
  });

  it('retries once, naming the markers that were missing', async () => {
    const provider = fakeProvider((_u, i) => (i === 0 ? tagged('[0]Salut !') : tagged('[0]Salut !\n[1]Ça roule ?\n[2]Parfait.')));
    const { outcome } = await refine(adapter(), srt(), { provider });
    expect(provider.calls).toHaveLength(2);
    expect(provider.calls[1].system).toContain('Missing indices last time: [1], [2]');
    expect(out(outcome)).toContain('Parfait.');
  });

  it('keeps the draft for cues the model keeps skipping', async () => {
    const provider = fakeProvider(() => tagged('[0]Salut !'));
    const { outcome, logs } = await refine(adapter(), srt(), { provider });
    expect(outcome.status).toBe('completed');
    expect(logs.filter((e) => e === 'srt_refinement_fallback').length).toBeGreaterThanOrEqual(2);
    expect(out(outcome)).toContain('Ça va bien ?');
    expect(out(outcome)).toContain('Salut !');
  });

  it('passes the last refined cues of a block to the next block', async () => {
    const provider = fakeProvider((_u, i) => tagged(i === 0 ? '[0]Salut !\n[1]Ça roule ?' : '[0]Parfait.'));
    await refine(adapter(2), srt(), { provider });
    expect(provider.calls[1].user).toContain('# CONTEXT - Previous Refined Block');
    expect(provider.calls[1].user).toContain('[0]Salut !\n[1]Ça roule ?');
  });
});

describe('refine mode (EPUB)', () => {
  const epub = async (provider: ReturnType<typeof fakeProvider>, over: Omit<Partial<TranslateJobArgs>, 'provider'> = {}) => {
    const input = await buildEpub({ paragraphs: 4 });
    return refine(new EpubAdapter(input, { targetLanguage: 'French' }), input, { provider, ...over });
  };
  const polish = (user: string) => tagged(sourceOf(user).replace(/Chapter One/g, 'Chapitre Un'));

  it('polishes chunks with their placeholders and rebuilds a valid book', async () => {
    const provider = fakeProvider((u) => polish(u));
    const { outcome } = await epub(provider);
    expect(outcome.status).toBe('completed');
    expect(provider.calls.every((c) => c.system?.includes('PLACEHOLDER PRESERVATION'))).toBe(true);

    const book = await readEpub(bytes(outcome));
    const ch1 = parseXmlDoc(await book.text('OEBPS/ch1.xhtml'));
    expect(ch1.getElementsByTagName('parsererror')).toHaveLength(0);
    expect(ch1.querySelector('h1')?.textContent).toBe('Chapitre Un');
    expect(ch1.querySelectorAll('p.body')).toHaveLength(4);
    expect(await book.text('OEBPS/toc.ncx')).toContain('<text>Chapitre Un</text>'); // TOC follows the new heading
  });

  it('keeps the draft of a chunk whose placeholders the model corrupted', async () => {
    const provider = fakeProvider((u) => tagged(sourceOf(u).replace(/\[id\d+\]/g, '')));
    const { outcome, logs } = await epub(provider);
    expect(outcome.status).toBe('completed');
    expect(logs).toContain('epub_refinement_placeholder_corruption');
    const ch1 = parseXmlDoc(await (await readEpub(bytes(outcome))).text('OEBPS/ch1.xhtml'));
    expect(ch1.querySelectorAll('p.body')).toHaveLength(4); // structure intact
    expect(ch1.querySelector('h1')?.textContent).toBe('Chapter One'); // untouched draft
  });

  it('never sends a chunk that is only markup (the cover) and uses no glossary', async () => {
    const provider = fakeProvider((u) => polish(u));
    await epub(provider, { glossary: { terms: new Map([['Chapter One', 'Chapitre Un']]) } });
    expect(provider.calls.every((c) => /\p{L}/u.test(sourceOf(c.user).replace(/\[id\d+\]/g, '')))).toBe(true);
    expect(provider.calls.every((c) => !c.user.includes('# GLOSSARY'))).toBe(true);
  });
});
