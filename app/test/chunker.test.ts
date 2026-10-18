import { describe, expect, it } from 'vitest';
import reference from './fixtures/python-reference.json';
import { TokenChunker } from '../src/chunking/tokenChunker';
import { splitChunkForRetry } from '../src/translate/splitChunk';

describe('TokenChunker matches the Python implementation', () => {
  for (const c of reference.chunker) {
    it(c.name, () => {
      const chunker = new TokenChunker(c.max_tokens);
      expect(chunker.countTokens(c.text)).toBe(c.token_count);
      const expected = c.chunks.map((x: any) => ({
        contextBefore: x.context_before,
        mainContent: x.main_content,
        contextAfter: x.context_after,
        joinWith: x.join_with,
      }));
      expect(chunker.chunkText(c.text)).toEqual(expected);
    });
  }

  it('never exceeds the hard limit on chunks it could split', () => {
    const c = reference.chunker.find((x) => x.name === 'paragraphs/max=100')!;
    const chunker = new TokenChunker(100);
    for (const chunk of chunker.chunkText(c.text)) {
      expect(chunker.countTokens(chunk.mainContent)).toBeLessThanOrEqual(100);
    }
  });
});

describe('splitChunkForRetry matches the Python implementation', () => {
  for (const c of reference.split) {
    it(c.name, () => {
      expect(splitChunkForRetry(c.text, c.ratio)).toEqual([c.first, c.second]);
    });
  }
});
