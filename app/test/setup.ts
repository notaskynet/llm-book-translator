import { afterAll, afterEach, beforeAll } from 'vitest';
import { initTokenizer } from '../src/chunking/tokenChunker';
import { server } from '../src/mocks/node';

beforeAll(async () => {
  await initTokenizer();
  server.listen({ onUnhandledFrame: 'error' });
});
afterEach(() => server.resetHandlers());
afterAll(() => server.close());
