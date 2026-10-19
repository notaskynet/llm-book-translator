export interface LLMResponse {
  content: string;
  promptTokens: number;
  completionTokens: number;
  /** Prompt + completion tokens. */
  contextUsed: number;
  contextLimit: number;
  wasTruncated: boolean;
  /** True when the raw response was used because tag extraction failed. */
  wasFallback: boolean;
  finishReason?: string | null;
  /** True when the provider says generation hit the output token limit. */
  outputTruncated: boolean;
}

export type LogCallback = (event: string, message: string, data?: Record<string, unknown>) => void;

export interface GenerateOptions {
  systemPrompt?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}

/** What the translation pipeline needs from an LLM backend. */
export interface LLMProvider {
  generate(prompt: string, options?: GenerateOptions): Promise<LLMResponse | null>;
  extractTranslation(response: string): string | null;
}

/** True when a provider stop reason means "ran out of output tokens". */
export function isOutputLimitFinish(finishReason: string | null | undefined): boolean {
  return ['length', 'max_tokens', 'max_output_tokens'].includes(String(finishReason ?? '').trim().toLowerCase());
}
