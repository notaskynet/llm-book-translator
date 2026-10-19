import { describe, expect, it } from 'vitest';
import { WorkerMessageHandler } from 'pdfjs-dist/legacy/build/pdf.worker.mjs';
import { extractPdfText } from '../src/documents/pdf';
import { createAdapter, mimeTypeFor, outputFileName, refinedFileName } from '../src/formats';
import { translateJob } from '../src/translate/generic';
import { fakeProvider, MemoryStore, sourceOf, tagged } from './helpers';
import { buildPdf } from './pdfFixture';

// pdf.js runs its worker in-process under Node.
(globalThis as { pdfjsWorker?: unknown }).pdfjsWorker = { WorkerMessageHandler };

const book = buildPdf([
  [
    { text: 'The traveller walked slowly along the old road, and' },
    { text: 'the evening light was grad-' },
    { text: 'ually fading behind the hills.' },
    { text: 'A new paragraph starts after a larger gap.', extra: 14 },
    { text: 'It spans a second line.' },
    { text: 'It ends on this page with no full stop and', extra: 14 },
  ],
  [{ text: 'carries on over the page break.' }, { text: 'Last one (with brackets).', extra: 14 }],
]);

describe('PDF input', () => {
  it('rebuilds paragraphs from the text layer, joining lines, hyphens and page breaks', async () => {
    const text = await extractPdfText(book);
    expect(text.split('\n\n')).toEqual([
      'The traveller walked slowly along the old road, and the evening light was gradually fading behind the hills.',
      'A new paragraph starts after a larger gap. It spans a second line.',
      'It ends on this page with no full stop and carries on over the page break.',
      'Last one (with brackets).',
    ]);
  });

  it('returns nothing for a PDF without text', async () => {
    expect(await extractPdfText(buildPdf([[]]))).toBe('');
  });

  it('translates a PDF as text and delivers a .txt', async () => {
    const provider = fakeProvider((user) => tagged(`«${sourceOf(user).trim()}»`));
    const outcome = await translateJob({
      adapter: createAdapter('book.pdf', new Uint8Array(book).buffer, { maxTokensPerChunk: 450 }),
      store: new MemoryStore(), translationId: 'pdf1', fileName: 'book.pdf', input: new Uint8Array(book).buffer,
      sourceLanguage: 'English', targetLanguage: 'French', provider,
    });
    expect(outcome.status).toBe('completed');
    const output = new TextDecoder().decode((outcome as { output: Uint8Array }).output);
    expect(output).toContain('gradually fading behind the hills.');
    expect(output.startsWith('«')).toBe(true);
    expect(outputFileName('book.pdf', 'French')).toBe('book (French).txt');
    expect(refinedFileName('book.pdf')).toBe('book (refined).txt');
    expect(mimeTypeFor('book.pdf')).toContain('text/plain');
  });

  it('fails cleanly on a scanned PDF', async () => {
    const logs: string[] = [];
    const empty = buildPdf([[]]);
    const outcome = await translateJob({
      adapter: createAdapter('scan.pdf', new Uint8Array(empty).buffer, { log: (e) => logs.push(e) }),
      store: new MemoryStore(), translationId: 'pdf2', fileName: 'scan.pdf', input: new Uint8Array(empty).buffer,
      sourceLanguage: 'English', targetLanguage: 'French', provider: fakeProvider((u) => tagged(u)),
    });
    expect(outcome.status).toBe('failed');
    expect(logs).toContain('pdf_no_text');
  });
});
