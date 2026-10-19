import { readFileSync } from 'node:fs';
import JSZip from 'jszip';
import { expect, test } from '@playwright/test';
import { buildDocx } from '../test/docxFixture';
import { buildPdf } from '../test/pdfFixture';
import { connect, mockLlm, upload } from './helpers';

const guillemets = (source: string) =>
  source.split(/(\[id\d+\])/).map((part) => (/^\[id\d+\]$/.test(part) || !part.trim() ? part : `«${part.trim()}»`)).join('');

test('translates a DOCX in place and downloads a Word file', async ({ page }) => {
  await mockLlm(page, { translate: guillemets });
  await connect(page);

  const docx = await buildDocx({ footnotes: true });
  await upload(page, {
    name: 'novel.docx',
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    buffer: Buffer.from(docx),
  });
  await expect(page.getByRole('status').last()).toContainText('Done');

  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download' }).click();
  const dl = await download;
  expect(dl.suggestedFilename()).toBe('novel (French).docx');

  const zip = await JSZip.loadAsync(readFileSync((await dl.path())!));
  const xml = await zip.file('word/document.xml')!.async('string');
  expect(xml).toContain('«Chapter One»');
  expect(xml).toContain('<w:drawing>');
  expect(xml).not.toMatch(/\[id\d+\]/);
  expect(await zip.file('word/footnotes.xml')!.async('string')).toContain('«A footnote about the road.»');
  expect(zip.file('word/media/image1.png')).not.toBeNull();
});

test('translates the text layer of a PDF and downloads a text file', async ({ page }) => {
  await mockLlm(page);
  await connect(page);

  const pdf = buildPdf([[{ text: 'The traveller walked slowly along the old road.' }, { text: 'It was a dark and quiet night.', extra: 14 }]]);
  await upload(page, { name: 'story.pdf', mimeType: 'application/pdf', buffer: Buffer.from(pdf) });
  await expect(page.getByRole('status').last()).toContainText('Done');

  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download' }).click();
  const dl = await download;
  expect(dl.suggestedFilename()).toBe('story (French).txt');
  const text = readFileSync((await dl.path())!, 'utf8');
  expect(text).toContain('FR The traveller walked slowly along the old road.');
  expect(text).toContain('It was a dark and quiet night.');
});

test('reports a PDF without a text layer', async ({ page }) => {
  await mockLlm(page);
  await connect(page);
  await upload(page, { name: 'scan.pdf', mimeType: 'application/pdf', buffer: Buffer.from(buildPdf([[]])) });
  await expect(page.getByRole('status').last()).toContainText('The file could not be read');
  await expect(page.getByText('has no text layer')).toBeAttached();
});
