import { expect, type Page, type Route } from '@playwright/test';

export const BASE = 'https://llm.test/v1';
export const sentence = 'The traveller walked slowly along the old road. ';
export const book = Array.from({ length: 12 }, (_, i) => `Paragraph ${i}. ${sentence.repeat(8)}`).join('\n\n');

/** Mocks the OpenAI-compatible API: echoes each source text back prefixed with "FR ". */
export async function mockLlm(
  page: Page,
  opts: {
    delayMs?: number;
    onRequest?: () => void;
    translate?: (source: string) => string;
    /** Every request as the model saw it. */
    record?: Array<{ system: string; user: string }>;
    /** Answer for a request, or undefined to fall through to the default translation. */
    respond?: (system: string, user: string) => string | undefined;
  } = {},
) {
  const seen: string[] = [];
  await page.route(`${BASE}/models`, (route) =>
    route.fulfill({ json: { object: 'list', data: [{ id: 'mock-model', object: 'model' }] }, headers: cors }));
  await page.route(`${BASE}/chat/completions`, async (route: Route) => {
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    const body = route.request().postDataJSON() as { messages: { role?: string; content: string }[] };
    const user = body.messages.at(-1)!.content;
    const system = body.messages.find((m: { role?: string }) => m.role === 'system')?.content ?? '';
    opts.record?.push({ system, user });
    const source = /<SOURCE_TEXT>\n([\s\S]*?)\n<\/SOURCE_TEXT>/.exec(user)?.[1] ?? '';
    seen.push(source);
    opts.onRequest?.();
    if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
    await route.fulfill({
      headers: cors,
      json: {
        id: 'x', object: 'chat.completion', created: 0, model: 'mock-model',
        choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: opts.respond?.(system, user) ?? `<TRANSLATION>${opts.translate ? opts.translate(source) : `FR ${source}`}</TRANSLATION>` } }],
        usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
      },
    });
  });
  // Preflight for the cross-origin fetch the SDK makes.
  await page.route(`${BASE}/**`, (route) => (route.request().method() === 'OPTIONS' ? route.fulfill({ status: 204, headers: cors }) : route.fallback()));
  return seen;
}

export const cors = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': '*',
  'access-control-allow-methods': '*',
};

export async function connect(page: Page) {
  await page.goto('/');
  await page.getByLabel('Base URL').fill(BASE);
  await page.getByLabel('API key').fill('test-key-not-real');
  await page.getByRole('button', { name: 'Load models' }).click();
  await expect(page.getByRole('status')).toContainText('1 models available');
  await page.getByLabel('Model').fill('mock-model');
}

export const file = (name = 'book.txt', text = book) => ({ name, mimeType: 'text/plain', buffer: Buffer.from(text) });


type Upload = Parameters<ReturnType<Page['locator']>['setInputFiles']>[0];

/** Chooses a file in the Translate tab and starts the job (a chosen file waits for the button). */
export async function upload(page: Page, files: Upload) {
  await page.locator('input[type=file]').setInputFiles(files);
  await page.getByRole('button', { name: /^(Translate|Polish)$/ }).click();
}
