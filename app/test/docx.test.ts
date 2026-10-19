import { describe, expect, it } from 'vitest';
import { DocxAdapter, W_NS } from '../src/docx/adapter';
import { translateJob } from '../src/translate/generic';
import { fakeProvider, MemoryStore, sourceOf, tagged } from './helpers';
import { parseXmlDoc } from './epubFixture';
import { buildDocx, readDocx } from './docxFixture';

/** A well-behaved fake model: wraps each run of text in «», keeping placeholders untouched. */
const guillemets = (source: string) =>
  source
    .split(/(\[id\d+\])/)
    .map((part) => (/^\[id\d+\]$/.test(part) || !part.trim() ? part : `«${part.trim()}»`))
    .join('');
const obedient = (user: string) => tagged(guillemets(sourceOf(user)));

const buffer = (b: Uint8Array) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;

async function run(options: { provider?: ReturnType<typeof fakeProvider>; bilingual?: boolean; input?: Uint8Array; footnotes?: boolean; maxTokensPerChunk?: number; store?: MemoryStore; shouldInterrupt?: () => boolean } = {}) {
  const input = options.input ?? (await buildDocx({ footnotes: options.footnotes }));
  const provider = options.provider ?? fakeProvider(obedient);
  const store = options.store ?? new MemoryStore();
  const outcome = await translateJob({
    adapter: new DocxAdapter(input, { maxTokensPerChunk: options.maxTokensPerChunk ?? 450 }),
    store, translationId: 'docx1', fileName: 'book.docx', input: buffer(input),
    sourceLanguage: 'English', targetLanguage: 'French', provider, bilingual: options.bilingual,
    callbacks: { shouldInterrupt: options.shouldInterrupt },
  });
  return { outcome, provider, store };
}

const outputOf = (outcome: Awaited<ReturnType<typeof run>>['outcome']) => {
  if (!('output' in outcome) || !outcome.output) throw new Error(`no output (status ${outcome.status})`);
  return outcome.output;
};

const paragraphs = (xml: string) => Array.from(parseXmlDoc(xml).getElementsByTagNameNS(W_NS, 'p'));
const textOf = (p: Element) => Array.from(p.getElementsByTagNameNS(W_NS, 't')).map((t) => t.textContent).join('');

describe('DOCX translation end to end', () => {
  it('translates the text in place and keeps every run property, picture and section', async () => {
    const { outcome } = await run({ footnotes: true });
    expect(outcome.status).toBe('completed');
    const docx = await readDocx(outputOf(outcome));
    const xml = await docx.text('word/document.xml');
    const doc = parseXmlDoc(xml);
    expect(doc.getElementsByTagName('parsererror')).toHaveLength(0);
    expect(xml).not.toMatch(/\[id\d+\]/);

    const ps = paragraphs(xml);
    expect(textOf(ps[0])).toBe('«Chapter One»');
    expect(ps[0].getElementsByTagNameNS(W_NS, 'pStyle')[0].getAttributeNS(W_NS, 'val')).toBe('Heading1');

    // Formatting stays attached to the right text.
    const body = ps[1];
    const runs = Array.from(body.getElementsByTagNameNS(W_NS, 'r'));
    const bold = runs.find((r) => r.getElementsByTagNameNS(W_NS, 'b').length);
    expect(textOf(bold!)).toContain('Important words');
    expect(textOf(bold!)).toContain('«');
    expect(runs.some((r) => r.getElementsByTagNameNS(W_NS, 'rFonts')[0]?.getAttributeNS(W_NS, 'ascii') === 'Georgia')).toBe(true);
    expect(body.getElementsByTagNameNS(W_NS, 'tab')).toHaveLength(1);

    // Non-text content is untouched.
    expect(doc.getElementsByTagNameNS(W_NS, 'drawing')).toHaveLength(1);
    expect(doc.getElementsByTagNameNS(W_NS, 'sectPr')).toHaveLength(1);
    expect(doc.getElementsByTagNameNS(W_NS, 'tbl')).toHaveLength(1);
    expect(textOf(ps.find((p) => textOf(p).includes('table'))!)).toBe('«Cell text in a table.»');
    expect(textOf(ps.find((p) => textOf(p).includes('chips'))!)).toBe('«Fish & chips <3.»');
    expect(docx.names).toContain('word/media/image1.png');
    expect(Array.from(await docx.bytes('word/media/image1.png'))).toEqual([137, 80, 78, 71]);

    // The footnote part is translated too.
    expect(textOf(paragraphs(await docx.text('word/footnotes.xml'))[0])).toBe('«A footnote about the road.»');
  });

  it('merges runs with the same formatting so the model sees whole sentences', async () => {
    const { provider } = await run();
    const first = sourceOf(provider.calls[0].user);
    // "Paragraph 0. " and the sentence share one font: they read as a single span.
    expect(first).toContain('Paragraph 0. The traveller walked slowly along the old road.');
  });

  it('still produces a valid document when the model drops every placeholder', async () => {
    const provider = fakeProvider((user) => tagged(sourceOf(user).replace(/\[id\d+\]/g, '').trim() + ' TRANSLATED'));
    const { outcome } = await run({ provider });
    expect(outcome.status).toBe('completed');
    const xml = await (await readDocx(outputOf(outcome))).text('word/document.xml');
    expect(parseXmlDoc(xml).getElementsByTagName('parsererror')).toHaveLength(0);
    expect(xml).not.toMatch(/\[id\d+\]/);
    expect(xml).toContain('TRANSLATED');
    expect(parseXmlDoc(xml).getElementsByTagNameNS(W_NS, 'drawing')).toHaveLength(1);
  });

  it('writes a bilingual copy after each paragraph without duplicating pictures', async () => {
    const { outcome } = await run({ bilingual: true });
    const xml = await (await readDocx(outputOf(outcome))).text('word/document.xml');
    const ps = paragraphs(xml);
    expect(textOf(ps[0])).toBe('Chapter One');
    expect(textOf(ps[1])).toBe('«Chapter One»');
    expect(parseXmlDoc(xml).getElementsByTagNameNS(W_NS, 'drawing')).toHaveLength(1);
  });

  it('resumes a stopped job from its checkpoints without repeating finished chunks', async () => {
    const input = await buildDocx({ paragraphs: 12 });
    const store = new MemoryStore();
    let calls = 0;
    const first = await run({ input, store, maxTokensPerChunk: 100, shouldInterrupt: () => calls++ >= 3 });
    expect(first.outcome.status).toBe('paused');
    const done = first.provider.calls.length;

    const second = await run({ input, store, maxTokensPerChunk: 100 });
    expect(second.outcome.status).toBe('completed');
    expect(done).toBeGreaterThan(0);
    const total = (await run({ input, maxTokensPerChunk: 100 })).provider.calls.length;
    expect(second.provider.calls.length).toBeLessThan(total);
    expect(await (await readDocx(outputOf(second.outcome))).text('word/document.xml')).toContain('«Paragraph 11.');
  });

  it('refuses a file that is not a Word document', async () => {
    const adapter = new DocxAdapter(new TextEncoder().encode('not a zip'));
    expect(await adapter.prepareForTranslation()).toBe(false);
  });
});

describe('DOCX and PDF as samples', () => {
  it('reads paragraphs out of a Word file for glossaries, styles and Sample & Compare', async () => {
    const { extractParagraphs } = await import('../src/documents/sampler');
    const text = await extractParagraphs('.docx', await buildDocx({ paragraphs: 1 }));
    expect(text?.split('\n\n')[0]).toBe('Chapter One');
    expect(text).toContain('Cell text in a table.');
    expect(text).toContain('Fish & chips <3.');
  });
});
