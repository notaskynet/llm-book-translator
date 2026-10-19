import { describe, expect, it } from 'vitest';
import { ContextOverflowError } from '../src/llm/errors';
import { TranslationExtractor } from '../src/llm/extraction';
import type { GenerateOptions, LLMProvider, LLMResponse } from '../src/llm/types';
import { translateChunk } from '../src/translate/request';

const resp = (content: string, extra: Partial<LLMResponse> = {}): LLMResponse => ({
  content, promptTokens: 0, completionTokens: 0, contextUsed: 0, contextLimit: 0,
  wasTruncated: false, wasFallback: false, finishReason: 'stop', outputTruncated: false, ...extra,
});

/** Provider driven by a script: each call pops the next step (a response, null, or an error). */
function scripted(steps: Array<LLMResponse | null | Error | ((prompt: string) => LLMResponse)>) {
  const extractor = new TranslationExtractor();
  const prompts: string[] = [];
  const provider: LLMProvider = {
    async generate(prompt: string, _o?: GenerateOptions) {
      prompts.push(prompt);
      const step = steps.shift();
      if (step instanceof Error) throw step;
      return typeof step === 'function' ? step(prompt) : (step ?? null);
    },
    extractTranslation: (r) => extractor.extract(r),
  };
  return { provider, prompts, events: [] as string[] };
}

const base = { contextBefore: '', contextAfter: '', previousTranslationContext: '', sourceLanguage: 'English', targetLanguage: 'French' };
const run = (s: ReturnType<typeof scripted>, mainContent: string, extra = {}) =>
  translateChunk({ ...base, mainContent, provider: s.provider, log: (e) => s.events.push(e), ...extra });

const longText = (n: number) => Array.from({ length: n }, (_, i) => `Sentence number ${i} is here.`).join(' ');

describe('translateChunk', () => {
  it('translates and extracts the tagged answer', async () => {
    const s = scripted([resp('<TRANSLATION>Bonjour le monde.</TRANSLATION>')]);
    expect((await run(s, 'Hello world.')).translation).toBe('Bonjour le monde.');
    expect(s.prompts[0]).toContain('<SOURCE_TEXT>\nHello world.\n</SOURCE_TEXT>');
  });

  it('skips the model for empty or single-character chunks', async () => {
    const s = scripted([]);
    expect((await run(s, ' x ')).translation).toBe(' x ');
    expect(s.prompts).toHaveLength(0);
    expect(s.events).toContain('skip_translation');
  });

  it('fails the chunk when the provider returns nothing', async () => {
    expect((await run(scripted([null]), 'Hello world.')).translation).toBeNull();
  });

  it('fails on an empty (refused) response', async () => {
    const s = scripted([resp('   ')]);
    expect((await run(s, 'Hello world.')).translation).toBeNull();
    expect(s.events).toContain('empty_llm_response');
  });

  it('fails instead of saving a half translation when output was truncated', async () => {
    const s = scripted([resp('<TRANSLATION>Bonjour', { outputTruncated: true, finishReason: 'length' })]);
    expect((await run(s, 'Hello world.')).translation).toBeNull();
    expect(s.events).toContain('output_truncated');
  });

  it('fails on an unclosed translation tag', async () => {
    const s = scripted([resp('<TRANSLATION>Bonjour le')]);
    expect((await run(s, 'Hello world.')).translation).toBeNull();
    expect(s.events).toContain('unclosed_translation_tag');
  });

  it('falls back to the raw response in plain-text mode when tags are missing', async () => {
    const s = scripted([resp('  Bonjour le monde.  ')]);
    const out = await run(s, 'Hello world.');
    expect(out.translation).toBe('Bonjour le monde.');
    expect(out.response?.wasFallback).toBe(true);
  });

  it('refuses the raw fallback when the model echoed the input', async () => {
    const s = scripted([resp('Here you go: Hello world.')]);
    expect((await run(s, 'Hello world.')).translation).toBeNull();
    expect(s.events).toContain('llm_prompt_in_response_warning');
  });

  it('never uses the raw response when placeholders are present', async () => {
    const s = scripted([resp('Bonjour')]);
    expect((await run(s, '[id0]Hello[id1] world', { hasPlaceholders: true })).translation).toBeNull();
    expect(s.events).toContain('epub_extraction_critical_fail');
  });

  it('shrinks the chunk after a context overflow and stitches the parts together', async () => {
    const text = longText(40);
    const s = scripted([
      new ContextOverflowError('too long'),
      (p) => resp(`<TRANSLATION>PART(${p.includes('Sentence number 0 ') ? 'first' : '?'})</TRANSLATION>`),
      resp('<TRANSLATION>PART(second)</TRANSLATION>'),
    ]);
    const out = await run(s, text);
    expect(out.translation).toBe('PART(first)\nPART(second)');
    expect(s.events).toContain('context_overflow_retry');
    // The second request carries the end of the first translation as context.
    expect(s.prompts[2]).toContain('PART(first)');
  });

  it('gives up after the maximum number of reductions', async () => {
    const text = longText(80);
    const s = scripted(Array.from({ length: 6 }, () => new ContextOverflowError('too long')));
    expect((await run(s, text)).translation).toBeNull();
    expect(s.events).toContain('context_overflow_fatal');
  });

  it('does not shrink a chunk that is already below the minimum size', async () => {
    const s = scripted([new ContextOverflowError('too long')]);
    expect((await run(s, 'A short chunk of text. Not much here.')).translation).toBeNull();
    expect(s.events).toContain('context_overflow_fatal');
  });

  it('lets other errors (rate limit, cancellation) propagate', async () => {
    await expect(run(scripted([new Error('boom')]), 'Hello world.')).rejects.toThrow('boom');
  });

  it('injects the glossary block for the content being sent', async () => {
    const s = scripted([resp('<TRANSLATION>ok</TRANSLATION>')]);
    await run(s, 'Hello world.', { buildGlossaryBlock: (c: string) => `# GLOSSARY for ${c.length} chars` });
    expect(s.prompts[0]).toContain('# GLOSSARY for 12 chars');
  });
});
