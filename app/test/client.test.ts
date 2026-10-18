import { describe, expect, it } from 'vitest';
import { classifyError, listModels } from '../src/llm/client';
import { MOCK_MODELS } from '../src/mocks/handlers';

describe('llm client', () => {
  it('lists models from an OpenAI-compatible endpoint', async () => {
    const ids = await listModels('https://example.test/v1', 'ok-key');
    expect(ids).toEqual([...MOCK_MODELS].sort());
  });

  it('classifies a 401 as unauthorized', async () => {
    const err = await listModels('https://example.test/v1', 'bad-key').catch((e) => e);
    expect(classifyError(err)).toBe('unauthorized');
  });
});
