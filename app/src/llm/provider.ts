// OpenAI-compatible provider. Port of src/core/llm/providers/openai.py with the
// transport delegated to the official `openai` SDK and transient retries to cockatiel.

import OpenAI from 'openai';
import { ConstantBackoff, handleWhen, retry } from 'cockatiel';
import { MAX_TRANSLATION_ATTEMPTS, REQUEST_TIMEOUT_MS } from '../config';
import { ContextOverflowError } from './errors';
import { TranslationExtractor } from './extraction';
import { KeyPool, normalizeApiKeys } from './keyPool';
import { handleRateLimit, isRetryableHttpStatus, type LogFn } from './rateLimit';
import { isOutputLimitFinish, type GenerateOptions, type LLMProvider, type LLMResponse } from './types';

const CONTEXT_OVERFLOW_KEYWORDS = [
  'context_length', 'maximum context', 'token limit', 'too many tokens', 'reduce the length',
  'max_tokens', 'context', 'truncate', 'length', 'too long',
];

export interface ProviderOptions {
  baseUrl: string;
  model: string;
  /** Comma/newline separated; rotated on HTTP 429. Empty for keyless endpoints. */
  apiKeys?: string;
  providerName?: string;
  log?: LogFn;
  /** Delay between transient retries. */
  retryDelayMs?: number;
  /** Injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
}

function errorMessage(err: InstanceType<typeof OpenAI.APIError>): string {
  const body = err.error as { message?: unknown } | undefined;
  return typeof body?.message === 'string' && body.message ? body.message : err.message;
}

export class OpenAICompatibleProvider implements LLMProvider {
  readonly model: string;
  private readonly pool?: KeyPool;
  private readonly clients = new Map<string, OpenAI>();
  private readonly extractor = new TranslationExtractor();
  private readonly retryPolicy;

  constructor(private readonly opts: ProviderOptions) {
    this.model = opts.model;
    const keys = normalizeApiKeys(opts.apiKeys);
    if (keys.length) this.pool = new KeyPool(keys, opts.providerName ?? 'openai');

    this.retryPolicy = retry(
      handleWhen((err) => this.isTransient(err)),
      // The first attempt plus MAX_TRANSLATION_ATTEMPTS - 1 retries.
      { maxAttempts: MAX_TRANSLATION_ATTEMPTS - 1, backoff: new ConstantBackoff(opts.retryDelayMs ?? 2000) },
    );
  }

  extractTranslation(response: string): string | null {
    return this.extractor.extract(response);
  }

  private clientFor(key: string | undefined): OpenAI {
    const id = key ?? '';
    let client = this.clients.get(id);
    if (!client) {
      client = new OpenAI({
        baseURL: this.opts.baseUrl,
        apiKey: key ?? 'none',
        dangerouslyAllowBrowser: true,
        maxRetries: 0, // retries are handled here so 429s can rotate keys
      });
      this.clients.set(id, client);
    }
    return client;
  }

  private isRateLimitWithPool(err: unknown): boolean {
    return !!this.pool && err instanceof OpenAI.APIError && err.status === 429;
  }

  private isTransient(err: unknown): boolean {
    if (err instanceof ContextOverflowError || err instanceof OpenAI.APIUserAbortError) return false;
    if (this.isRateLimitWithPool(err)) return false;
    if (err instanceof OpenAI.APIError && typeof err.status === 'number') {
      return isRetryableHttpStatus(err.status);
    }
    return true; // timeouts, dropped connections, malformed bodies
  }

  /**
   * Sends one prompt. Resolves to null when the request failed for good (bad
   * request, auth error, retries exhausted); throws ContextOverflowError,
   * RateLimitError, or an AbortError when the caller cancelled.
   */
  async generate(prompt: string, options: GenerateOptions = {}): Promise<LLMResponse | null> {
    const { systemPrompt, signal, timeoutMs = REQUEST_TIMEOUT_MS } = options;
    const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [];
    if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
    messages.push({ role: 'user', content: prompt });

    let rateLimitEvents = 0;
    for (;;) {
      const key = this.pool?.acquire();
      try {
        return await this.retryPolicy.execute(() => this.request(key, messages, signal, timeoutMs));
      } catch (err) {
        if (this.isRateLimitWithPool(err)) {
          rateLimitEvents += 1;
          await handleRateLimit(
            this.pool!, key!, (err as InstanceType<typeof OpenAI.APIError>).headers,
            rateLimitEvents, MAX_TRANSLATION_ATTEMPTS, this.opts.log, this.opts.sleep,
          );
          continue;
        }
        if (err instanceof ContextOverflowError || err instanceof OpenAI.APIUserAbortError) throw err;
        if (signal?.aborted) throw err;

        const status = err instanceof OpenAI.APIError ? err.status : undefined;
        this.opts.log?.(
          'llm_request_failed',
          `❌ LLM request failed${status ? ` (HTTP ${status})` : ''}: ${err instanceof Error ? err.message : String(err)}`,
        );
        return null;
      }
    }
  }

  private async request(
    key: string | undefined,
    messages: OpenAI.Chat.ChatCompletionMessageParam[],
    signal: AbortSignal | undefined,
    timeoutMs: number,
  ): Promise<LLMResponse> {
    try {
      const completion = await this.clientFor(key).chat.completions.create(
        { model: this.model, messages, stream: false },
        { signal, timeout: timeoutMs },
      );
      const choice = completion.choices?.[0];
      const finishReason = choice?.finish_reason ?? null;
      const promptTokens = completion.usage?.prompt_tokens ?? 0;
      const completionTokens = completion.usage?.completion_tokens ?? 0;
      const contextUsed = promptTokens + completionTokens;
      if (promptTokens || completionTokens) {
        this.opts.log?.('token_usage', `Tokens: prompt=${promptTokens}, response=${completionTokens}, total=${contextUsed}`);
      }
      return {
        content: choice?.message?.content ?? '',
        promptTokens,
        completionTokens,
        contextUsed,
        contextLimit: 0,
        wasTruncated: false, // context overflow surfaces as an error instead
        wasFallback: false,
        finishReason,
        outputTruncated: isOutputLimitFinish(finishReason),
      };
    } catch (err) {
      if (err instanceof OpenAI.APIError && typeof err.status === 'number' && err.status !== 429) {
        const message = errorMessage(err);
        if (CONTEXT_OVERFLOW_KEYWORDS.some((k) => message.toLowerCase().includes(k))) {
          this.opts.log?.('llm_context_overflow', `❌ Context size exceeded: ${message}`);
          throw new ContextOverflowError(message);
        }
      }
      throw err;
    }
  }
}
