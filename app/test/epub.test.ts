import { describe, expect, it } from 'vitest';
import { EpubAdapter } from '../src/epub/adapter';
import { translateJob } from '../src/translate/generic';
import { fakeProvider, MemoryStore, response, sourceOf, tagged } from './helpers';
import { buildEpub, parseXmlDoc, readEpub } from './epubFixture';

/** A well-behaved fake model: wraps each run of text in «», keeping placeholders untouched. */
const guillemets = (source: string) =>
  source
    .split(/(\[id\d+\])/)
    .map((part) => (/^\[id\d+\]$/.test(part) || !part.trim() ? part : `«${part.trim()}»`))
    .join('');

const obedient = (user: string) => tagged(guillemets(sourceOf(user)));

interface RunOptions {
  provider?: ReturnType<typeof fakeProvider>;
  store?: MemoryStore;
  bilingual?: boolean;
  parallelWorkers?: number;
  glossary?: Parameters<typeof translateJob>[0]['glossary'];
  promptOptions?: Parameters<typeof translateJob>[0]['promptOptions'];
  maxTokensPerChunk?: number;
  shouldInterrupt?: () => boolean;
  input?: Uint8Array;
  paragraphs?: number;
  missingSpineFile?: boolean;
}

async function run(options: RunOptions = {}) {
  const input = options.input ?? (await buildEpub({ paragraphs: options.paragraphs, missingSpineFile: options.missingSpineFile }));
  const provider = options.provider ?? fakeProvider(obedient);
  const store = options.store ?? new MemoryStore();
  const logs: string[] = [];
  const outcome = await translateJob({
    adapter: new EpubAdapter(input, {
      maxTokensPerChunk: options.maxTokensPerChunk ?? 450, targetLanguage: 'French', log: (e) => logs.push(e),
    }),
    store, translationId: 'epub1', fileName: 'book.epub', input: input.buffer.slice(input.byteOffset, input.byteOffset + input.byteLength) as ArrayBuffer,
    sourceLanguage: 'English', targetLanguage: 'French', provider,
    bilingual: options.bilingual, parallelWorkers: options.parallelWorkers, glossary: options.glossary, promptOptions: options.promptOptions,
    callbacks: { onLog: (e) => logs.push(e), shouldInterrupt: options.shouldInterrupt },
  });
  return { outcome, provider, store, logs };
}

const outputOf = (outcome: Awaited<ReturnType<typeof run>>['outcome']) => {
  if (!('output' in outcome) || !outcome.output) throw new Error(`no output (status ${outcome.status})`);
  return outcome.output;
};

describe('EPUB translation end to end', () => {
  it('translates the spine, keeps structure and localises metadata', async () => {
    const { outcome, provider } = await run();
    expect(outcome.status).toBe('completed');
    const epub = await readEpub(outputOf(outcome));

    // Tags, attributes and structure survive.
    const ch1 = parseXmlDoc(await epub.text('OEBPS/ch1.xhtml'));
    expect(ch1.getElementsByTagName('parsererror')).toHaveLength(0);
    expect(ch1.querySelector('h1')?.getAttribute('id')).toBe('c1');
    expect(ch1.querySelector('h1')?.textContent).toBe('«Chapter One»');
    expect(ch1.querySelectorAll('p.body').length).toBe(6);
    expect(ch1.querySelector('p.body em')).not.toBeNull();
    expect(ch1.querySelector('p.body a')?.getAttribute('href')).toBe('ch2.xhtml#s2');
    expect(ch1.querySelector('img')?.getAttribute('src')).toBe('images/pic.png');
    expect(await epub.text('OEBPS/ch1.xhtml')).not.toMatch(/\[id\d+\]/);

    // The href is percent-encoded in the OPF but the file name has a space.
    const ch2 = await epub.text('OEBPS/Chapter 2.xhtml');
    expect(ch2).toContain('«Second Part»');
    expect(ch2).toContain('«It was a'); // text around a <span> stays in one chunk
    expect(ch2).toContain('Fish &amp; chips &lt;3');

    // Language: <html lang>, xml:lang and dc:language.
    expect(parseXmlDoc(await epub.text('OEBPS/ch1.xhtml')).documentElement.getAttribute('lang')).toBe('fr');
    expect(await epub.text('OEBPS/Chapter 2.xhtml')).toMatch(/xml:lang="fr"/);
    expect(await epub.text('OEBPS/content.opf')).toContain('<dc:language>fr</dc:language>');

    // TOC labels follow the translated headings; targets are untouched.
    const ncx = await epub.text('OEBPS/toc.ncx');
    expect(ncx).toContain('<text>«Chapter One»</text>');
    expect(ncx).toContain('src="Chapter%202.xhtml#s2"');
    const nav = await epub.text('OEBPS/nav.xhtml');
    expect(nav).toContain('«Second Part»');
    expect(nav).toContain('>Start<'); // landmarks are left alone
    expect(nav).toContain('lang="fr"');

    // Non-text assets are copied as-is.
    expect(await epub.text('OEBPS/style.css')).toBe('body { margin: 1em; }');
    expect([...(await epub.zip.file('OEBPS/images/pic.png')!.async('uint8array'))]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);

    // The cover has no text, so it never reached the model.
    expect(provider.calls.every((c) => !sourceOf(c.user).includes('[id0][id1]') || /[A-Za-z]/.test(sourceOf(c.user)))).toBe(true);
  });

  it('writes a valid EPUB container: mimetype first and stored', async () => {
    const { outcome } = await run();
    const bytes = outputOf(outcome);
    expect(new TextDecoder().decode(bytes.slice(30, 38))).toBe('mimetype');
    const epub = await readEpub(bytes);
    expect(epub.names[0]).toBe('mimetype');
    expect(await epub.text('mimetype')).toBe('application/epub+zip');
    // method field (offset 8) is 0 = stored
    expect(bytes[8]).toBe(0);
    expect(bytes[9]).toBe(0);
  });

  it('uses token alignment when the model drops the placeholders', async () => {
    const provider = fakeProvider((user, _i, system) =>
      system?.includes('PLACEHOLDER PRESERVATION')
        ? tagged(sourceOf(user).replace(/\[id\d+\]/g, '').replace(/\s+/g, ' ')) // placeholders lost
        : tagged(`FR ${sourceOf(user)}`),
    );
    const { outcome, logs } = await run({ provider });
    expect(outcome.status).toBe('completed');
    expect(logs).toContain('phase2_warning');

    const ch1 = parseXmlDoc(await (await readEpub(outputOf(outcome))).text('OEBPS/ch1.xhtml'));
    expect(ch1.getElementsByTagName('parsererror')).toHaveLength(0);
    expect(ch1.querySelectorAll('p.body').length).toBe(6); // structure is still intact
    expect(ch1.querySelector('h1')?.textContent).toContain('FR');
  });

  it('keeps a chunk in the source language and ends partial when nothing works', async () => {
    const provider = fakeProvider(() => null);
    const { outcome, logs } = await run({ provider });
    expect(outcome.status).toBe('partial');
    expect(logs).toContain('unit_failed');
    const epub = await readEpub(outputOf(outcome));
    const ch1 = await epub.text('OEBPS/ch1.xhtml');
    expect(ch1).toContain('Chapter One'); // the source text is still there
    expect(ch1).not.toContain('«');
    expect(parseXmlDoc(ch1).getElementsByTagName('parsererror')).toHaveLength(0);
  });

  it('produces bilingual output with the original followed by its translation', async () => {
    const { outcome } = await run({ bilingual: true });
    expect(outcome.status).toBe('completed');
    const ch1 = parseXmlDoc(await (await readEpub(outputOf(outcome))).text('OEBPS/ch1.xhtml'));
    const originals = [...ch1.querySelectorAll('.bilingual-original')];
    const translations = [...ch1.querySelectorAll('.bilingual-translation')];
    expect(originals.length).toBeGreaterThan(5);
    expect(originals.length).toBe(translations.length);
    expect(originals[0].textContent).toBe('Chapter One');
    expect(translations[0].textContent).toBe('«Chapter One»');
  });

  it('escapes stray angle brackets and entities from the model', async () => {
    const provider = fakeProvider((user) => tagged(guillemets(sourceOf(user)).replace('«Second Part»', '«<Skill> Part &nbsp; &hellip;»')));
    const { outcome } = await run({ provider });
    expect(outcome.status).toBe('completed');
    const ch2 = await (await readEpub(outputOf(outcome))).text('OEBPS/Chapter 2.xhtml');
    expect(parseXmlDoc(ch2).getElementsByTagName('parsererror')).toHaveLength(0);
    expect(parseXmlDoc(ch2).querySelector('h2')?.textContent).toBe('«<Skill> Part   …»');
  });

  it('skips spine entries that are missing from the archive', async () => {
    const { outcome, logs } = await run({ missingSpineFile: true });
    expect(outcome.status).toBe('completed');
    expect(logs).toContain('epub_file_not_found');
  });

  it('sends the glossary and style instructions with EPUB chunks, including the fallback request', async () => {
    const glossary = { terms: new Map([['Chapter One', 'Chapitre Premier']]) };
    const provider = fakeProvider((user, _i, system) =>
      system?.includes('PLACEHOLDER PRESERVATION') ? tagged('no placeholders') : tagged(guillemets(sourceOf(user))));
    const { outcome } = await run({ provider, glossary, promptOptions: { custom_instructions: 'Stay formal.' } });
    expect(outcome.status).toBe('completed');

    const calls = provider.calls.filter((c) => sourceOf(c.user).includes('Chapter One'));
    const withTags = calls.filter((c) => c.system?.includes('PLACEHOLDER PRESERVATION'));
    expect(withTags.length).toBe(2);
    for (const c of withTags) expect(c.user).toContain('Chapter One -> Chapitre Premier');
    // The token-alignment request has its placeholders cut out, which also removes the word
    // boundary after the term ("Chapter One[id1]It" -> "Chapter OneIt"), so the term no longer
    // matches there. The style instructions still apply to every request.
    expect(calls.length).toBeGreaterThan(withTags.length);
    for (const c of calls) expect(c.system).toContain('Stay formal.');
  });

  it('fails cleanly for a file that is not an EPUB', async () => {
    const { outcome } = await run({ input: new TextEncoder().encode('definitely not a zip') });
    expect(outcome).toMatchObject({ status: 'failed', error: 'prepare_failed' });
  });

  it('translates in parallel and resumes after an interruption without repeating units', async () => {
    const input = await buildEpub({ paragraphs: 12 });
    const store = new MemoryStore();

    let interrupt = false;
    const first = fakeProvider((user) => ((interrupt = true), obedient(user)));
    const paused = await run({ input, store, provider: first, maxTokensPerChunk: 80, shouldInterrupt: () => interrupt });
    expect(paused.outcome.status).toBe('paused');
    expect(first.calls.length).toBeGreaterThan(0);

    const second = fakeProvider(obedient);
    const resumed = await run({ input, store, provider: second, maxTokensPerChunk: 80, parallelWorkers: 3 });
    expect(resumed.outcome.status).toBe('completed');
    expect(second.maxInFlight).toBeGreaterThan(1);

    const firstSources = new Set(first.calls.map((c) => sourceOf(c.user)));
    expect(second.calls.some((c) => firstSources.has(sourceOf(c.user)))).toBe(false); // nothing translated twice

    // A straight run gives the same book.
    const straight = await run({ input, provider: fakeProvider(obedient), maxTokensPerChunk: 80 });
    const a = await readEpub(outputOf(resumed.outcome));
    const b = await readEpub(outputOf(straight.outcome));
    expect(await a.text('OEBPS/ch1.xhtml')).toBe(await b.text('OEBPS/ch1.xhtml'));
  });

  it('survives a model that answers with an empty body for one chunk', async () => {
    let n = 0;
    const provider = fakeProvider((user) => (++n === 2 ? response('') : obedient(user)));
    const { outcome } = await run({ provider, maxTokensPerChunk: 80, paragraphs: 12 });
    expect(['completed', 'partial']).toContain(outcome.status);
    const ch1 = parseXmlDoc(await (await readEpub(outputOf(outcome))).text('OEBPS/ch1.xhtml'));
    expect(ch1.getElementsByTagName('parsererror')).toHaveLength(0);
    expect(ch1.querySelectorAll('p.body').length).toBe(12);
  });
});
