import OpenAI from 'openai';

/** Splits a comma/newline separated key string into a clean list. */
export function normalizeApiKeys(raw: string): string[] {
  return raw.split(/[,\n]/).map((k) => k.trim()).filter(Boolean);
}

export function createClient(baseUrl: string, apiKey: string): OpenAI {
  const [first] = normalizeApiKeys(apiKey);
  return new OpenAI({
    baseURL: baseUrl,
    apiKey: first ?? 'none',
    dangerouslyAllowBrowser: true,
    maxRetries: 0, // retries are handled by the policy layer, not the SDK
  });
}

export async function listModels(baseUrl: string, apiKey: string, signal?: AbortSignal): Promise<string[]> {
  const client = createClient(baseUrl, apiKey);
  const page = await client.models.list({ signal });
  return page.data.map((m) => m.id).sort();
}

export type ConnectionErrorKind = 'unauthorized' | 'network' | 'other';

export function classifyError(err: unknown): ConnectionErrorKind {
  if (err instanceof OpenAI.APIError && (err.status === 401 || err.status === 403)) return 'unauthorized';
  if (err instanceof OpenAI.APIConnectionError) return 'network'; // includes CORS failures
  return 'other';
}
