import { http, HttpResponse } from 'msw';

export const MOCK_MODELS = ['mock-translator', 'mock-small'];

/** Handlers match any host so they work for every base-URL preset. */
export const handlers = [
  http.get('*/models', ({ request }) => {
    const auth = request.headers.get('authorization') ?? '';
    if (auth.includes('bad-key')) {
      return HttpResponse.json({ error: { message: 'Invalid API key' } }, { status: 401 });
    }
    return HttpResponse.json({ object: 'list', data: MOCK_MODELS.map((id) => ({ id, object: 'model' })) });
  }),
  http.post('*/chat/completions', async ({ request }) => {
    const body = (await request.json()) as { model: string; messages: { content: string }[] };
    const last = body.messages[body.messages.length - 1]?.content ?? '';
    return HttpResponse.json({
      id: 'chatcmpl-mock',
      object: 'chat.completion',
      created: 0,
      model: body.model,
      choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: last } }],
    });
  }),
];
