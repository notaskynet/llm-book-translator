import { describe, expect, it } from 'vitest';
import { RateLimitError } from '../src/llm/errors';
import { SrtAdapter } from '../src/formats/srt';
import { TxtAdapter } from '../src/formats/txt';
import { encodeUtf8 } from '../src/formats/types';
import { translateJob, type TranslationStats } from '../src/translate/generic';
import { fakeProvider, MemoryStore, response, sourceOf, tagged } from './helpers';

const sentence = 'The traveller walked slowly along the old road. ';
const bookText = Array.from({ length: 12 }, (_, i) => `Paragraph ${i}. ${sentence.repeat(8)}`).join('\n\n');
const dec = (b?: Uint8Array) => new TextDecoder().decode(b);

function txtJob(over: Partial<Parameters<typeof translateJob>[0]> & { provider: ReturnType<typeof fakeProvider> }) {
  const input = encodeUtf8(bookText);
  const store = (over.store as MemoryStore) ?? new MemoryStore();
  return {
    store,
    run: (extra: Partial<Parameters<typeof translateJob>[0]> = {}) =>
      translateJob({
        adapter: new TxtAdapter(input, { maxTokensPerChunk: 300 }),
        store, translationId: 'job1', fileName: 'book.txt', input: input.buffer as ArrayBuffer,
        sourceLanguage: 'English', targetLanguage: 'French', ...over, ...extra,
      }),
  };
}

/** A full-length fake translation: the source with an `FR ` prefix, tagged. */
const echoFr = (user: string) => tagged(`FR ${sourceOf(user)}`);

describe('glossary and style instructions', () => {
  it('injects only the glossary entries that match each chunk', async () => {
    const provider = fakeProvider(echoFr);
    const glossary = { terms: new Map([['Paragraph 3', 'Abschnitt 3']]), metadata: { 'Paragraph 3': { category: 'other' } } };
    const { run } = txtJob({ provider });
    expect((await run({ glossary })).status).toBe('completed');

    const withTerm = provider.calls.filter((c) => sourceOf(c.user).includes('Paragraph 3.'));
    const without = provider.calls.filter((c) => !sourceOf(c.user).includes('Paragraph 3.'));
    expect(withTerm.length).toBeGreaterThan(0);
    expect(without.length).toBeGreaterThan(0);
    for (const c of withTerm) expect(c.user).toContain('  - Paragraph 3 -> Abschnitt 3  [other]');
    for (const c of without) expect(c.user).not.toContain('GLOSSARY');
  });

  it('puts the cast block in every chunk, even those without a match', async () => {
    const provider = fakeProvider(echoFr);
    const glossary = { terms: new Map([['Zed', 'Zed']]), metadata: { Zed: { gender: 'female' } } };
    await txtJob({ provider }).run({ glossary });
    expect(provider.calls.every((c) => c.user.includes('# CAST - CHARACTER GENDERS') && c.user.includes('Zed — female'))).toBe(true);
    expect(provider.calls.every((c) => !c.user.includes('# GLOSSARY'))).toBe(true);
  });

  it('applies the style instructions to every request', async () => {
    const provider = fakeProvider(echoFr);
    await txtJob({ provider }).run({ promptOptions: { custom_instructions: 'Use a formal register.' } });
    expect(provider.calls.every((c) => c.system?.includes('# STYLE INSTRUCTIONS') && c.system.includes('Use a formal register.'))).toBe(true);
  });

  it('warns once when the glossary cap is hit', async () => {
    const terms = new Map(Array.from({ length: 5 }, (_, i) => [`Paragraph ${i}`, `P${i}`] as [string, string]));
    const logs: string[] = [];
    const provider = fakeProvider(echoFr);
    await txtJob({ provider }).run({ glossary: { terms, config: { maxEntries: 1 } }, callbacks: { onLog: (e) => logs.push(e) } });
    expect(logs.filter((e) => e === 'glossary_capped')).toHaveLength(1);
  });
});

describe('translateJob (TXT)', () => {
  it('translates every unit sequentially, chains context and completes', async () => {
    const provider = fakeProvider(echoFr);
    const { run, store } = txtJob({ provider });
    const stats: TranslationStats[] = [];
    const out = await run({ callbacks: { onStats: (s) => stats.push(s) } });

    expect(out.status).toBe('completed');
    expect(out.status === 'completed' && dec(out.output)).toContain('FR Paragraph 0.');
    expect(provider.maxInFlight).toBe(1);
    expect(provider.calls.length).toBeGreaterThan(2);
    // The second request carries the tail of the first translation as context.
    expect(provider.calls[1].user).toContain('# CONTEXT - Previous Paragraph');
    expect(provider.calls[1].user).toContain(`FR ${sourceOf(provider.calls[0].user)}`.slice(-200));
    expect(store.jobs.get('job1')?.status).toBe('completed');
    expect(stats.at(-1)).toMatchObject({ completedChunks: provider.calls.length, failedChunks: 0, unfinishedChunks: 0 });
  });

  it('runs units in parallel without chaining context', async () => {
    const provider = fakeProvider(async (u) => (await new Promise((r) => setTimeout(r, 5)), echoFr(u)));
    const { run } = txtJob({ provider });
    const out = await run({ parallelWorkers: 3 });
    expect(out.status).toBe('completed');
    expect(provider.maxInFlight).toBe(3);
    expect(provider.calls.every((c) => !c.user.includes('# CONTEXT - Previous Paragraph'))).toBe(true);
  });

  it('keeps going after a failed unit, ends partial, and the output falls back to the source', async () => {
    const provider = fakeProvider((u, i) => (i === 1 ? null : echoFr(u)));
    const { run, store } = txtJob({ provider });
    const out = await run();
    expect(out.status).toBe('partial');
    if (out.status !== 'partial') return;
    expect(out.stats.failedChunks).toBe(1);
    expect(dec(out.output)).toContain('Paragraph 2.'); // untranslated text survives somewhere
    expect(store.chunks.get('job1:1')?.status).toBe('failed');
    expect(store.jobs.get('job1')?.status).toBe('partial');
  });

  it('resumes: only failed and never-attempted units are requested again', async () => {
    const store = new MemoryStore();
    const first = fakeProvider((u, i) => (i === 1 ? null : echoFr(u)));
    expect((await txtJob({ provider: first, store }).run()).status).toBe('partial');
    const total = first.calls.length;

    const second = fakeProvider(echoFr);
    const out = await txtJob({ provider: second, store }).run();
    expect(out.status).toBe('completed');
    expect(second.calls).toHaveLength(1); // just the failed unit
    expect(out.status === 'completed' && out.stats.runProcessedChunks).toBe(1);
    expect(total).toBeGreaterThan(2);
  });

  it('pauses on interruption, returns partial output and resumes from there', async () => {
    const store = new MemoryStore();
    let interrupt = false;
    const first = fakeProvider((u) => (interrupt = true, echoFr(u)));
    const out = await txtJob({ provider: first, store }).run({ callbacks: { shouldInterrupt: () => interrupt } });
    expect(out.status).toBe('paused');
    if (out.status !== 'paused') return;
    expect(out.reason).toBe('interrupted');
    expect(dec(out.output)).toContain('FR Paragraph 0.');
    expect(first.calls).toHaveLength(1);
    expect(store.jobs.get('job1')?.status).toBe('paused');

    const second = fakeProvider(echoFr);
    expect((await txtJob({ provider: second, store }).run()).status).toBe('completed');
    expect(second.calls.every((c) => !c.user.includes(sourceOf(first.calls[0].user)))).toBe(true);
  });

  it('pauses with a rate_limit reason and keeps committed units', async () => {
    const store = new MemoryStore();
    const provider = fakeProvider((u, i) => {
      if (i === 2) throw new RateLimitError('slow down', 30, 'openai');
      return echoFr(u);
    });
    const out = await txtJob({ provider, store }).run();
    expect(out).toMatchObject({ status: 'paused', reason: 'rate_limit', retryAfter: 30 });
    expect([...store.chunks.values()].filter((c) => c.status === 'completed')).toHaveLength(2);
    expect(store.jobs.get('job1')?.status).toBe('paused');
  });

  it('retries a unit whose translation is far too short, with reinforced instructions', async () => {
    const provider = fakeProvider((u, i) => (i === 0 ? tagged('x') : echoFr(u)));
    const { run } = txtJob({ provider });
    const out = await run();
    expect(out.status).toBe('completed');
    expect(provider.calls[1].system).toContain('STYLE INSTRUCTIONS');
    expect(provider.calls[1].system).toContain('part of the text was probably skipped');
  });

  it('marks the unit failed when validation never passes', async () => {
    const provider = fakeProvider((u, i) => (i < 3 ? tagged('x') : echoFr(u)));
    const { run } = txtJob({ provider });
    const out = await run();
    expect(out.status).toBe('partial');
    expect(provider.calls.slice(0, 3)).toHaveLength(3); // 1 + UNIT_VALIDATION_RETRIES attempts
  });

  it('fails cleanly for an empty file', async () => {
    const input = encodeUtf8('   ');
    const out = await translateJob({
      adapter: new TxtAdapter(input), store: new MemoryStore(), translationId: 'e', fileName: 'e.txt',
      input: input.buffer as ArrayBuffer, sourceLanguage: 'English', targetLanguage: 'French',
      provider: fakeProvider(echoFr),
    });
    expect(out).toMatchObject({ status: 'failed', error: 'no_units' });
  });

  it('produces bilingual output', async () => {
    const { run } = txtJob({ provider: fakeProvider(echoFr) });
    const out = await run({ bilingual: true });
    expect(out.status === 'completed' && dec(out.output)).toContain('─'.repeat(40));
  });
});

const srt = `1
00:00:01,000 --> 00:00:03,000
Hello there.

2
00:00:03,500 --> 00:00:05,000
How are you?

3
00:00:06,000 --> 00:00:08,000
Fine, thanks.
`;

describe('translateJob (SRT)', () => {
  const job = (provider: ReturnType<typeof fakeProvider>) => {
    const input = encodeUtf8(srt);
    return translateJob({
      adapter: new SrtAdapter(input, { linesPerBlock: 10 }), store: new MemoryStore(), translationId: 's1',
      fileName: 'a.srt', input: input.buffer as ArrayBuffer, sourceLanguage: 'English', targetLanguage: 'French', provider,
    });
  };

  it('translates a block and keeps timecodes', async () => {
    const provider = fakeProvider(() => tagged('[0]Bonjour.\n[1]Comment ça va ?\n[2]Bien, merci.'));
    const out = await job(provider);
    expect(out.status).toBe('completed');
    const text = out.status === 'completed' ? dec(out.output) : '';
    expect(text).toContain('00:00:03,500 --> 00:00:05,000\nComment ça va ?');
  });

  it('retries with a reinforced prompt when a marker is dropped', async () => {
    const provider = fakeProvider((_u, i) => (i === 0 ? tagged('[0]Bonjour.\n[2]Bien.') : tagged('[0]Bonjour.\n[1]Ça va ?\n[2]Bien.')));
    const out = await job(provider);
    expect(out.status).toBe('completed');
    expect(provider.calls).toHaveLength(2);
    expect(provider.calls[1].system).toContain('missing subtitle index markers: [1]');
  });

  it('keeps the parsed cues but ends partial when markers never come back', async () => {
    const provider = fakeProvider(() => tagged('[0]Bonjour.\n[2]Bien.'));
    const out = await job(provider);
    expect(out.status).toBe('partial');
    const text = out.status === 'partial' ? dec(out.output) : '';
    expect(text).toContain('Bonjour.');
    expect(text).toContain('How are you?'); // missing cue falls back to the source
  });
});
