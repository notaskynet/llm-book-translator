import { describe, expect, it } from 'vitest';
import reference from './fixtures/python-reference.json';
import { chunkHtmlWithPlaceholders } from '../src/epub/htmlChunker';
import { getLanguageCode } from '../src/epub/langCodes';
import { isTextFreeChunk, restoreToGlobal, validatePlaceholders } from '../src/epub/placeholders';
import { isNonTranslatable, preserveTags, restoreTags } from '../src/epub/tagPreserver';
import { alignAndInsertPlaceholders, reinsertPlaceholders } from '../src/epub/tokenAlignment';
import { escapeStrayAngleBrackets, normalizeWhitespace } from '../src/epub/xmlText';

describe('TagPreserver matches the Python implementation', () => {
  for (const c of reference.epub_bodies) {
    it(c.name, () => {
      const tagMapRef = c.tag_map as Record<string, string>;
      const { text, tagMap } = preserveTags(c.body);
      expect(text).toBe(c.text);
      expect(tagMap).toEqual(tagMapRef);
      expect(restoreTags(text, tagMap)).toBe(c.restored);
      expect(c.restored).toBe(c.body);
    });
  }

  for (const c of reference.epub_non_translatable) {
    it(`isNonTranslatable(${JSON.stringify(c.text)})`, () => expect(isNonTranslatable(c.text)).toBe(c.result));
  }
});

describe('HtmlChunker matches the Python implementation', () => {
  for (const c of reference.epub_bodies) {
    for (const [maxTokens, expected] of Object.entries(c.chunks)) {
      it(`${c.name} @${maxTokens} tokens`, () => {
        const chunks = chunkHtmlWithPlaceholders(c.text, c.tag_map as Record<string, string>, Number(maxTokens));
        expect(
          chunks.map((k) => ({
            text: k.text, local_tag_map: k.localTagMap, global_offset: k.globalOffset, global_indices: k.globalIndices,
          })),
        ).toEqual(expected);
      });
    }
  }

  // Upstream quirk, kept for parity: splitting an oversized paragraph into sentences drops the
  // whitespace between them ("road.The traveller"), so only whitespace may differ after a round trip.
  it('reassembles to the original document (chunk, restore indices, restore tags)', () => {
    const squash = (s: string) => s.replace(/\s+/g, '');
    for (const c of reference.epub_bodies) {
      const chunks = chunkHtmlWithPlaceholders(c.text, c.tag_map as Record<string, string>, 60);
      const joined = chunks.map((k) => restoreToGlobal(k.text, k.globalIndices)).join('');
      expect(squash(restoreTags(joined, c.tag_map as Record<string, string>)), c.name).toBe(squash(c.body));
    }
  });
});

describe('placeholder helpers match the Python implementation', () => {
  for (const c of reference.epub_validate) {
    it(`validate ${JSON.stringify(c.text)}`, () => expect(validatePlaceholders(c.text, c.tag_map as Record<string, string>)).toBe(c.valid));
  }
  for (const c of reference.epub_restore) {
    it(`restoreToGlobal ${JSON.stringify(c.text)}`, () => expect(restoreToGlobal(c.text, c.global_indices)).toBe(c.result));
  }
  for (const c of reference.epub_text_free) {
    it(`isTextFreeChunk ${JSON.stringify(c.text)}`, () => expect(isTextFreeChunk(c.text)).toBe(c.result));
  }
});

describe('token alignment matches the Python implementation', () => {
  for (const c of reference.epub_align) {
    it(`align ${JSON.stringify(c.original)}`, () => {
      expect(alignAndInsertPlaceholders(c.original, c.translated, c.placeholders)).toBe(c.result);
    });
  }
  for (const c of reference.epub_reinsert) {
    it(`reinsert ${JSON.stringify(c.original)}`, () => {
      const positions = new Map(Object.entries(c.positions).map(([k, v]) => [Number(k), v as number]));
      expect(reinsertPlaceholders(c.translated, positions)).toBe(c.result);
    });
  }
});

describe('text helpers match the Python implementation', () => {
  for (const c of reference.epub_escape) {
    it(`escape ${JSON.stringify(c.text)}`, () => expect(escapeStrayAngleBrackets(c.text)).toBe(c.result));
  }
  for (const c of reference.epub_whitespace) {
    it(`normalizeWhitespace ${JSON.stringify(c.html)}`, () => expect(normalizeWhitespace(c.html)).toBe(c.result));
  }
  for (const c of reference.epub_lang) {
    it(`getLanguageCode ${JSON.stringify(c.input)}`, () => expect(getLanguageCode(c.input)).toBe(c.result));
  }
});
