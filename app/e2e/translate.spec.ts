import JSZip from 'jszip';
import { expect, test } from '@playwright/test';
import { buildEpub } from '../test/epubFixture';
import { BASE, connect, cors, file, mockLlm } from './helpers';

test('connects, translates a TXT file and downloads the result', async ({ page }) => {
  const seen = await mockLlm(page);
  await connect(page);

  await page.locator('input[type=file]').setInputFiles(file());
  await expect(page.getByRole('status').last()).toContainText('Done');

  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download' }).click();
  const dl = await download;
  expect(dl.suggestedFilename()).toBe('book (French).txt');
  const text = (await import('node:fs')).readFileSync((await dl.path())!, 'utf8');
  // The mock prefixes every chunk once, so the number of prefixes equals the number of requests.
  expect(text.match(/FR /g)).toHaveLength(seen.length);
  expect(text).toContain('Paragraph 11.');
  expect(seen.length).toBeGreaterThan(1);
});

test('rejects unsupported files', async ({ page }) => {
  await mockLlm(page);
  await connect(page);
  await page.locator('input[type=file]').setInputFiles({ name: 'cover.png', mimeType: 'image/png', buffer: Buffer.from('x') });
  await expect(page.getByRole('alert')).toContainText('.txt, .srt, .epub, .docx and .pdf');
});

test('shows a clear error for a wrong API key', async ({ page }) => {
  await page.route(`${BASE}/**`, (route) =>
    route.request().method() === 'OPTIONS'
      ? route.fulfill({ status: 204, headers: cors })
      : route.fulfill({ status: 401, headers: cors, json: { error: { message: 'Invalid API key' } } }));
  await page.goto('/');
  await page.getByLabel('Base URL').fill(BASE);
  await page.getByLabel('API key').fill('bad');
  await page.getByRole('button', { name: 'Load models' }).click();
  await expect(page.getByRole('alert')).toContainText('Invalid API key');
});

test('switching the UI language updates strings without a reload', async ({ page }) => {
  await mockLlm(page);
  await page.goto('/');
  await page.evaluate(() => { (window as any).__noReload = true; });
  await expect(page.getByRole('heading', { name: 'Translate' })).toBeVisible();

  await page.getByLabel('Language', { exact: true }).selectOption('fr');
  await expect(page.getByRole('heading', { name: 'Traduire' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Connexion' })).toBeVisible();
  expect(await page.evaluate(() => (window as any).__noReload)).toBe(true);

  await page.getByLabel('Langue', { exact: true }).selectOption('ja');
  await expect(page.getByRole('heading', { name: '翻訳' })).toBeVisible();
});

test('stops, survives a reload and resumes only the remaining units', async ({ page }) => {
  let requests = 0;
  const seen = await mockLlm(page, { delayMs: 500, onRequest: () => requests++ });
  await connect(page);

  // One request at a time, so stopping after the first leaves most of the book pending.
  await page.getByText('Options').click();
  await page.getByLabel('Parallel requests').fill('1');

  await page.locator('input[type=file]').setInputFiles(file());
  await expect.poll(() => requests).toBeGreaterThan(0);
  await page.getByRole('button', { name: 'Stop' }).click();
  await expect(page.getByRole('status').last()).toContainText('Stopped');
  const firstRun = seen.length;
  expect(firstRun).toBeGreaterThan(0);

  // A page reload loses all in-memory state; only IndexedDB survives.
  await page.reload();
  await expect(page.getByText('Unfinished translations')).toBeVisible();
  await expect(page.getByText('book.txt')).toBeVisible();

  await page.getByRole('button', { name: 'Resume' }).click();
  await expect(page.getByRole('status').last()).toContainText('Done');
  // No unit is translated twice: first run + second run covers each chunk exactly once.
  expect(new Set(seen).size).toBe(seen.length);

  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download' }).click();
  const text = (await import('node:fs')).readFileSync((await (await download).path())!, 'utf8');
  expect(text).toContain('FR Paragraph 0.');
  expect(text).toContain('Paragraph 11.');
  expect(text.match(/FR /g)).toHaveLength(seen.length);
});

test('translates an EPUB in a real browser and keeps it a valid book', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  // Wraps every run of text in FR(...) and leaves the [idN] placeholders alone.
  const seen = await mockLlm(page, {
    translate: (source) =>
      source.split(/(\[id\d+\])/).map((p) => (/^\[id\d+\]$/.test(p) || !p.trim() ? p : `FR(${p.trim()})`)).join(''),
  });
  await connect(page);

  await page.locator('input[type=file]').setInputFiles({
    name: 'novel.epub',
    mimeType: 'application/epub+zip',
    buffer: Buffer.from(await buildEpub({ paragraphs: 6 })),
  });
  await expect(page.getByRole('status').last()).toContainText('Done');

  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download' }).click();
  const dl = await download;
  expect(dl.suggestedFilename()).toBe('novel (French).epub');

  const zip = await JSZip.loadAsync((await import('node:fs')).readFileSync((await dl.path())!));
  const names = Object.keys(zip.files);
  expect(names[0]).toBe('mimetype');
  expect(await zip.file('mimetype')!.async('string')).toBe('application/epub+zip');

  const ch1 = await zip.file('OEBPS/ch1.xhtml')!.async('string');
  expect(ch1).toContain('<h1 id="c1">FR(Chapter One)</h1>');
  expect(ch1).toContain('class="body"');
  expect(ch1).not.toMatch(/\[id\d+\]/);
  expect(ch1).toMatch(/lang="fr"/);
  expect(await zip.file('OEBPS/content.opf')!.async('string')).toContain('<dc:language>fr</dc:language>');
  expect(await zip.file('OEBPS/toc.ncx')!.async('string')).toContain('<text>FR(Chapter One)</text>');
  expect(await zip.file('OEBPS/nav.xhtml')!.async('string')).toContain('FR(Second Part)');
  expect(seen.length).toBeGreaterThan(1);
  expect(errors).toEqual([]);
});
