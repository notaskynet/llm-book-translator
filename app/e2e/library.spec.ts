import { expect, test } from '@playwright/test';
import JSZip from 'jszip';
import { connect, file, mockLlm } from './helpers';

const goTo = (page: import('@playwright/test').Page, tab: 'Translate' | 'Styles' | 'Glossaries') =>
  page.getByRole('tab', { name: tab }).click();

test('a style created in the editor is sent with every translation request', async ({ page }) => {
  const record: Array<{ system: string; user: string }> = [];
  await mockLlm(page, { record });
  await connect(page);

  await goTo(page, 'Styles');
  await page.getByRole('button', { name: 'New blank style' }).click();
  const dialog = page.getByRole('dialog', { name: 'Edit style' });
  await dialog.getByLabel('Style name').fill('Dry noir');
  await dialog.getByRole('button', { name: 'Add rule' }).click();
  await dialog.getByRole('textbox', { name: 'Style rules' }).fill('Keep sentences short and detached');
  // The prompt block follows the rules until it is edited by hand.
  await expect(dialog.getByLabel('Translation instructions')).toHaveValue(/Keep sentences short and detached\./);
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Dry noir')).toBeVisible();

  await page.getByRole('button', { name: /Assign to translation/ }).click();
  await goTo(page, 'Translate');
  await expect(page.getByLabel('Style', { exact: true })).toHaveValue('Dry_noir');

  await page.locator('input[type=file]').setInputFiles(file());
  await expect(page.getByRole('status').last()).toContainText('Done');
  expect(record.length).toBeGreaterThan(1);
  for (const r of record) {
    expect(r.system).toContain('# STYLE INSTRUCTIONS');
    expect(r.system).toContain('Keep sentences short and detached.');
  }
});

test('a style exported as YAML can be imported again', async ({ page }) => {
  await mockLlm(page);
  await page.goto('/');
  await goTo(page, 'Styles');
  await page.getByRole('button', { name: 'New blank style' }).click();
  const dialog = page.getByRole('dialog', { name: 'Edit style' });
  await dialog.getByLabel('Style name').fill('Terse');
  await dialog.getByRole('button', { name: 'Add rule' }).click();
  await dialog.getByRole('textbox', { name: 'Style rules' }).fill('Prefer short paratactic sentences');
  await dialog.getByRole('button', { name: 'Save' }).click();

  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export' }).click();
  const dl = await download;
  expect(dl.suggestedFilename()).toBe('Terse.yaml');
  const yaml = (await import('node:fs')).readFileSync((await dl.path())!, 'utf8');
  expect(yaml).toContain('translation: |-');
  expect(yaml).toContain('- dimension: other');

  page.once('dialog', (d) => void d.accept()); // overwrite confirmation
  await page.getByLabel('Import', { exact: true }).setInputFiles({ name: 'Terse.yaml', mimeType: 'text/yaml', buffer: Buffer.from(yaml) });
  await expect(page.getByText('Saved: Terse')).toBeVisible();
});

test('a style is extracted from a book and only the abstract rules are kept by default', async ({ page }) => {
  await mockLlm(page, {
    respond: (system) =>
      system.includes('literary style analyst')
        ? `<STYLE_JSON>${JSON.stringify({
            summary: 'Terse and detached.',
            suggested_name: 'terse_detached',
            context: 'A frontier town.',
            rules: [
              { dimension: 'sentence_rhythm', instruction: 'Favor short sentences over long ones in action passages.', evidence: 'He ran.' },
              { dimension: 'lexicon', instruction: 'Use words like "dusk" and "gloom" often in descriptions.', evidence: 'dusk' },
            ],
          })}</STYLE_JSON>`
        : undefined,
  });
  await connect(page);
  await goTo(page, 'Styles');
  await page.getByRole('button', { name: 'New from books' }).click();

  const dialog = page.getByRole('dialog', { name: 'Extract a style from books' });
  await dialog.locator('input[type=file]').setInputFiles(file('novel.txt'));
  await dialog.getByRole('button', { name: 'Run extraction' }).click();

  const abstract = dialog.getByRole('checkbox', { name: /Favor short sentences/ });
  const quoting = dialog.getByRole('checkbox', { name: /dusk/ });
  await expect(abstract).toBeChecked();
  await expect(quoting).not.toBeChecked(); // flagged: quotes the book
  await expect(dialog.getByText('Quotes the book')).toBeVisible();

  await dialog.getByRole('button', { name: 'Create style' }).click();
  await expect(page.getByText('terse_detached')).toBeVisible();
  await expect(page.getByText('Style created')).toBeVisible();
});

test('a glossary is edited, assigned, and its matching terms reach the model', async ({ page }) => {
  const record: Array<{ system: string; user: string }> = [];
  await mockLlm(page, { record });
  await connect(page);

  await goTo(page, 'Glossaries');
  await page.getByLabel('Name', { exact: true }).fill('Saga');
  await page.getByRole('button', { name: 'New glossary' }).click();

  await page.getByRole('button', { name: 'Add a term' }).click();
  const table = page.getByRole('table');
  await table.getByRole('textbox', { name: 'Source' }).fill('Paragraph 3');
  await table.getByRole('textbox', { name: 'Target' }).fill('Abschnitt 3');
  await table.getByRole('combobox', { name: 'Category' }).selectOption('item');
  await expect(page.getByText('Saved')).toBeVisible();

  // Persisted: survives leaving the editor.
  await page.getByRole('button', { name: /← Glossaries/ }).click();
  await expect(page.getByText('Saga')).toBeVisible();
  await expect(page.getByText('1 term')).toBeVisible();
  await page.getByRole('button', { name: /Assign to translation/ }).click();

  await goTo(page, 'Translate');
  await page.locator('input[type=file]').setInputFiles(file());
  await expect(page.getByRole('status').last()).toContainText('Done');

  const matching = record.filter((r) => /<SOURCE_TEXT>[\s\S]*Paragraph 3\.[\s\S]*<\/SOURCE_TEXT>/.test(r.user));
  const others = record.filter((r) => !matching.includes(r));
  expect(matching.length).toBeGreaterThan(0);
  for (const r of matching) expect(r.user).toContain('  - Paragraph 3 -> Abschnitt 3  [item]');
  for (const r of others) expect(r.user).not.toContain('# GLOSSARY');
});

test('a CSV glossary is imported, previewed and exported', async ({ page }) => {
  await page.goto('/');
  await goTo(page, 'Glossaries');
  const csv = 'source,target,category,gender\nLi Fan,李凡,character,M\nMoscow|Moscou,Москва,location,\n,orphan,,\nLi Fan,dup,,\n';
  await page.getByLabel('Import CSV/JSON').setInputFiles({ name: 'cast.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) });
  await expect(page.getByText('Imported 2 terms.')).toBeVisible();
  await page.getByRole('button', { name: 'Edit glossary' }).click();

  await expect(page.getByRole('table').getByRole('textbox', { name: 'Source' })).toHaveCount(2);
  await expect(page.getByRole('combobox', { name: 'Gender' }).first()).toHaveValue('male');

  await page.getByRole('button', { name: 'Preview' }).click();
  const dialog = page.getByRole('dialog', { name: 'Preview prompt block' });
  await dialog.getByRole('textbox').fill('Li Fan met Moscou at dawn.');
  await dialog.getByRole('button', { name: 'Render' }).click();
  await expect(dialog.getByText('2 / 2 terms matched')).toBeVisible();
  await expect(dialog.locator('pre')).toContainText('Li Fan -> 李凡  [character, male]');
  await expect(dialog.locator('pre')).toContainText('# CAST - CHARACTER GENDERS');
  await dialog.getByRole('button', { name: 'Close' }).click();

  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'CSV' }).click();
  const exported = (await import('node:fs')).readFileSync((await (await download).path())!, 'utf8');
  expect(exported.split('\n')[0]).toBe('source,target,category,gender');
  expect(exported).toContain('Li Fan,李凡,character,male');
});

test('glossary terms are suggested from a book and added after review', async ({ page }) => {
  await mockLlm(page, {
    respond: (system) =>
      system.includes('literary entity extractor')
        ? `<NER_JSON>${JSON.stringify([
            { source: 'Aldric', target: 'Aldric', category: 'character', gender: 'male' },
            { source: 'Eldoria', target: 'Éldoria', category: 'location', gender: 'unknown' },
          ])}</NER_JSON>`
        : undefined,
  });
  await connect(page);
  await goTo(page, 'Glossaries');
  await page.getByLabel('Name', { exact: true }).fill('Auto');
  await page.getByRole('button', { name: 'New glossary' }).click();

  await page.getByRole('button', { name: 'Auto-extract' }).click();
  const dialog = page.getByRole('dialog', { name: 'Auto-extract candidates' });
  await dialog.locator('input[type=file]').setInputFiles(file('book.txt'));
  await dialog.getByRole('button', { name: 'Extract' }).click();

  // Aldric = Aldric (identical) starts unticked; Eldoria differs and starts ticked.
  await expect(dialog.getByRole('checkbox', { name: 'Eldoria' })).toBeChecked();
  await expect(dialog.getByRole('checkbox', { name: 'Aldric' })).not.toBeChecked();
  await dialog.getByRole('button', { name: 'Add selected' }).click();

  await expect(page.getByText('Added 1 term')).toBeVisible();
  await expect(page.getByRole('table').getByRole('textbox', { name: 'Target' })).toHaveValue('Éldoria');
});

test('an EPUB is translated with a glossary applied', async ({ page }) => {
  const record: Array<{ system: string; user: string }> = [];
  await mockLlm(page, { record, translate: (s) => s });
  await connect(page);
  await goTo(page, 'Glossaries');
  await page.getByLabel('Import CSV/JSON').setInputFiles({ name: 'terms.csv', mimeType: 'text/csv', buffer: Buffer.from('source,target\nChapter One,Chapitre Premier\n') });
  await expect(page.getByText('Imported 1 term.')).toBeVisible();
  await page.getByRole('button', { name: /Assign to translation/ }).click();

  await goTo(page, 'Translate');
  const { buildEpub } = await import('../test/epubFixture');
  await page.locator('input[type=file]').setInputFiles({ name: 'novel.epub', mimeType: 'application/epub+zip', buffer: Buffer.from(await buildEpub()) });
  await expect(page.getByRole('status').last()).toContainText('Done');
  expect(record.some((r) => r.user.includes('Chapter One -> Chapitre Premier'))).toBe(true);

  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download' }).click();
  const zip = await JSZip.loadAsync((await import('node:fs')).readFileSync((await (await download).path())!));
  expect(Object.keys(zip.files)[0]).toBe('mimetype');
});

test('a translation is polished in a second pass, and the draft stays available', async ({ page }) => {
  const record: Array<{ system: string; user: string }> = [];
  await mockLlm(page, {
    record,
    respond: (system, user) => {
      if (!system.includes('literary editor')) return undefined;
      const draft = /<SOURCE_TEXT>\n([\s\S]*?)\n<\/SOURCE_TEXT>/.exec(user)?.[1] ?? '';
      return `<TRANSLATION>POLI ${draft}</TRANSLATION>`;
    },
  });
  await connect(page);
  await page.getByText('Options').click();
  await page.getByLabel('Polish the translation afterwards (second pass)').check();

  await page.locator('input[type=file]').setInputFiles(file());
  await expect(page.getByRole('status').last()).toContainText('Done');

  const refineCalls = record.filter((r) => r.system.includes('literary editor'));
  const translateCalls = record.filter((r) => !r.system.includes('literary editor'));
  expect(translateCalls.length).toBeGreaterThan(1);
  expect(refineCalls.length).toBe(translateCalls.length);
  // The polish pass starts from the translation, not from the original.
  expect(refineCalls[0].user).toContain('FR Paragraph 0.');

  const polished = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download', exact: true }).click();
  const dl = await polished;
  expect(dl.suggestedFilename()).toBe('book (French) (refined).txt');
  const text = (await import('node:fs')).readFileSync((await dl.path())!, 'utf8');
  expect(text).toContain('POLI FR Paragraph 0.');

  const draft = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download the translation before polishing' }).click();
  const draftFile = await draft;
  expect(draftFile.suggestedFilename()).toBe('book (French).txt');
  expect((await import('node:fs')).readFileSync((await draftFile.path())!, 'utf8')).not.toContain('POLI');
});

test('an already translated file can be polished on its own', async ({ page }) => {
  const record: Array<{ system: string; user: string }> = [];
  await mockLlm(page, {
    record,
    respond: (_system, user) => `<TRANSLATION>POLI ${/<SOURCE_TEXT>\n([\s\S]*?)\n<\/SOURCE_TEXT>/.exec(user)?.[1] ?? ''}</TRANSLATION>`,
  });
  await connect(page);
  await page.getByLabel('Polish an existing translation').check();
  await expect(page.getByLabel('Source language')).toHaveCount(0); // only the file's own language is asked for

  await page.locator('input[type=file]').setInputFiles(file('translated.txt'));
  await expect(page.getByRole('status').last()).toContainText('Done');
  expect(record.every((r) => r.system.includes('literary editor'))).toBe(true);

  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download', exact: true }).click();
  expect((await download).suggestedFilename()).toBe('translated (refined).txt');
});

test('Sample & Compare runs two LLMs side by side and shows their differences', async ({ page }) => {
  const record: Array<{ system: string; user: string }> = [];
  await mockLlm(page, {
    record,
    respond: (system, user) => {
      const source = /<SOURCE_TEXT>\n([\s\S]*?)\n<\/SOURCE_TEXT>/.exec(user)?.[1] ?? '';
      const model = system.includes('Be lyrical.') ? 'lyrical' : 'plain';
      return `<TRANSLATION>${model.toUpperCase()}: ${source.slice(0, 30)}</TRANSLATION>`;
    },
  });
  await connect(page);

  // A style the second column will use.
  await page.getByRole('tab', { name: 'Styles' }).click();
  await page.getByRole('button', { name: 'New blank style' }).click();
  const dialog = page.getByRole('dialog', { name: 'Edit style' });
  await dialog.getByLabel('Style name').fill('Lyrical');
  await dialog.getByRole('button', { name: 'Add rule' }).click();
  await dialog.getByRole('textbox', { name: 'Style rules' }).fill('Be lyrical');
  await dialog.getByRole('button', { name: 'Save' }).click();
  await page.getByRole('tab', { name: 'Sample & Compare' }).click();

  const longBook = Array.from({ length: 14 }, (_, i) => `Paragraph ${i}. ${'The traveller walked slowly along the old road. '.repeat(30)}`).join('\n\n');
  await page.getByLabel('Drop a book to sample').setInputFiles(file('long.txt', longBook));
  await expect(page.getByText('Selected book')).toBeVisible();
  await expect(page.getByRole('table').getByRole('row')).toHaveCount(6); // header + 5 extracts

  await page.getByRole('button', { name: 'Add an LLM' }).click();
  await page.getByLabel('Style 2').selectOption('Lyrical');
  await page.getByRole('button', { name: 'Run', exact: true }).click();
  await expect(page.getByText('Sample run completed.')).toBeVisible();

  await expect(page.getByText(/PLAIN: /)).toHaveCount(5);
  await expect(page.getByText(/LYRICAL: /)).toHaveCount(5);
  // The style only reached the second column.
  expect(record.filter((r) => r.system.includes('Be lyrical.'))).toHaveLength(5);
  expect(record.filter((r) => !r.system.includes('Be lyrical.'))).toHaveLength(5);

  await page.getByLabel('Highlight differences from the first LLM').check();
  await expect(page.locator('mark').first()).toBeVisible();

  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.getByRole('button', { name: 'Copy as Markdown' }).click();
  await expect(page.getByText('Markdown copied to clipboard.')).toBeVisible();
  const markdown = await page.evaluate(() => navigator.clipboard.readText());
  expect(markdown.split('\n')[0]).toContain('LLM 1');
  expect(markdown.split('\n')).toHaveLength(7);

  // Adding another extract and running again only translates the new row.
  record.length = 0;
  await page.getByRole('button', { name: 'Add a sample' }).click();
  await page.getByRole('button', { name: 'Run', exact: true }).click();
  await expect(page.getByText('Sample run completed.')).toBeVisible();
  expect(record).toHaveLength(2);
});
