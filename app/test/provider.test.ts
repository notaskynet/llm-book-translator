import { describe, expect, it } from 'vitest';
import { http, HttpResponse } from 'msw';
import { server } from '../src/mocks/node';
import { ContextOverflowError, RateLimitError } from '../src/llm/errors';
import { OpenAICompatibleProvider } from '../src/llm/provider';

const BASE = 'https://llm.test/v1';
const ok = (content: string, finish = 'stop') =>
  HttpResponse.json({
    id: 'x', object: 'chat.completion', created: 0, model: 'm',
    choices: [{ index: 0, finish_reason: finish, message: { role: 'assistant', content } }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  });

function make(apiKeys = 'k1', extra: Record<string, unknown> = {}) {
  return new OpenAICompatibleProvider({
    baseUrl: BASE, model: 'm', apiKeys, retryDelayMs: 0, sleep: async () => {}, ...extra,
  });
}

describe('OpenAICompatibleProvider', () => {
  it('returns content, usage and finish reason, and sends system + user messages', async () => {
    let body: any;
    server.use(http.post(`${BASE}/chat/completions`, async ({ request }) => {
      body = await request.json();
      return ok('<TRANSLATION>Bonjour</TRANSLATION>');
    }));

    const res = await make().generate('Hello', { systemPrompt: 'sys' });
    expect(res).toMatchObject({ content: '<TRANSLATION>Bonjour</TRANSLATION>', promptTokens: 10, completionTokens: 5, contextUsed: 15, outputTruncated: false });
    expect(body.messages).toEqual([{ role: 'system', content: 'sys' }, { role: 'user', content: 'Hello' }]);
  });

  it('flags output truncation from finish_reason', async () => {
    server.use(http.post(`${BASE}/chat/completions`, () => ok('<TRANSLATION>cut', 'length')));
    expect((await make().generate('x'))?.outputTruncated).toBe(true);
  });

  it('rotates to the next key on 429 without consuming a retry', async () => {
    const seen: string[] = [];
    server.use(http.post(`${BASE}/chat/completions`, ({ request }) => {
      const auth = request.headers.get('authorization')!;
      seen.push(auth);
      return auth.endsWith('k1')
        ? HttpResponse.json({ error: { message: 'slow down' } }, { status: 429, headers: { 'Retry-After': '1' } })
        : ok('done');
    }));

    const res = await make('k1,k2').generate('x');
    expect(res?.content).toBe('done');
    expect(seen).toEqual(['Bearer k1', 'Bearer k2']);
  });

  it('raises RateLimitError when 429 persists', async () => {
    server.use(http.post(`${BASE}/chat/completions`, () =>
      HttpResponse.json({ error: { message: 'slow down' } }, { status: 429, headers: { 'Retry-After': '1' } })));
    await expect(make('k1').generate('x')).rejects.toBeInstanceOf(RateLimitError);
  });

  it('retries a transient 500 once and then succeeds', async () => {
    let calls = 0;
    server.use(http.post(`${BASE}/chat/completions`, () =>
      ++calls === 1 ? HttpResponse.json({ error: { message: 'boom' } }, { status: 500 }) : ok('fine')));
    expect((await make().generate('x'))?.content).toBe('fine');
    expect(calls).toBe(2);
  });

  it('gives up with null after the retries are exhausted', async () => {
    let calls = 0;
    server.use(http.post(`${BASE}/chat/completions`, () => (++calls, HttpResponse.json({ error: { message: 'boom' } }, { status: 500 }))));
    expect(await make().generate('x')).toBeNull();
    expect(calls).toBe(2);
  });

  it('does not retry auth errors', async () => {
    let calls = 0;
    server.use(http.post(`${BASE}/chat/completions`, () => (++calls, HttpResponse.json({ error: { message: 'Invalid API key' } }, { status: 401 }))));
    expect(await make().generate('x')).toBeNull();
    expect(calls).toBe(1);
  });

  it('maps context-length errors to ContextOverflowError without retrying', async () => {
    let calls = 0;
    server.use(http.post(`${BASE}/chat/completions`, () => (++calls, HttpResponse.json(
      { error: { message: "This model's maximum context length is 8192 tokens", code: 'context_length_exceeded' } }, { status: 400 }))));
    await expect(make().generate('x')).rejects.toBeInstanceOf(ContextOverflowError);
    expect(calls).toBe(1);
  });

  it('works without a key and treats 429 as an ordinary retryable error', async () => {
    let calls = 0;
    server.use(http.post(`${BASE}/chat/completions`, () =>
      ++calls === 1 ? HttpResponse.json({ error: { message: 'busy' } }, { status: 429 }) : ok('ok')));
    expect((await make('').generate('x'))?.content).toBe('ok');
    expect(calls).toBe(2);
  });

  it('propagates cancellation instead of returning null', async () => {
    server.use(http.post(`${BASE}/chat/completions`, () => ok('late')));
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(make().generate('x', { signal: ctrl.signal })).rejects.toThrow();
  });
});
