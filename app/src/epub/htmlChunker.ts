// Ports of src/core/epub/html_chunker.py, tag_classifier.py, text_splitter.py and
// placeholder_renumberer.py: chunking HTML-with-placeholders at block boundaries, with
// each chunk's placeholders renumbered locally (0, 1, 2...).

import { countTokens } from '../chunking/tokenChunker';
import { createPlaceholder, findAllPlaceholders } from './placeholders';

export interface HtmlChunk {
  /** Text with chunk-local placeholders. */
  text: string;
  localTagMap: Record<string, string>;
  globalOffset: number;
  /** Document-global index of each local placeholder, in order. */
  globalIndices: number[];
}

// --- TagClassifier -------------------------------------------------------------------

const BLOCK_TAGS = ['p', 'div', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'section', 'article', 'li', 'tr', 'td', 'th'];
const CHAPTER_HEADINGS = ['h1', 'h2', 'h3'];
const MAJOR_SECTIONS = ['h4', 'h5', 'h6', 'section', 'article'];
const PARAGRAPHS = ['p', 'div', 'blockquote'];

const closes = (tag: string, names: string[]) => names.some((n) => tag.includes(`</${n}>`));

export function isBlockClosingTag(tag: string): boolean {
  const t = tag.toLowerCase();
  return BLOCK_TAGS.some((b) => t.includes(`</${b}>`) || t.includes(`</${b} `));
}

export function isBlockOpeningTag(tag: string): boolean {
  const t = tag.toLowerCase();
  return BLOCK_TAGS.some((b) => t.includes(`<${b}>`) || t.includes(`<${b} `));
}

export function getSplitPriority(tag: string): number {
  const t = tag.toLowerCase();
  if (closes(t, CHAPTER_HEADINGS)) return 1;
  if (closes(t, MAJOR_SECTIONS)) return 2;
  if (closes(t, PARAGRAPHS)) return 3;
  return 4;
}

// --- TextSplitter --------------------------------------------------------------------

class TextSplitter {
  constructor(private readonly maxTokens: number) {}

  splitOversizedSegment(segment: string): string[] {
    const result: string[] = [];
    for (const sentence of this.splitOnSentences(segment)) {
      if (countTokens(sentence) <= this.maxTokens) {
        result.push(sentence);
        continue;
      }
      for (const punct of this.splitOnPunctuation(sentence)) {
        if (countTokens(punct) <= this.maxTokens) {
          result.push(punct);
          continue;
        }
        for (const line of this.splitOnNewlines(punct)) {
          if (countTokens(line) <= this.maxTokens) result.push(line);
          else result.push(...this.forceSplitAtTokens(line));
        }
      }
    }
    return result;
  }

  /** Greedily merges `parts` into segments that stay within the token limit. */
  private merge(text: string, parts: string[], joiner = ''): string[] {
    const segments: string[] = [];
    let current = '';
    for (const part of parts) {
      if (!part.trim()) continue;
      const test = current ? current + joiner + part : part;
      if (current && countTokens(test) > this.maxTokens) {
        if (current.trim()) segments.push(current);
        current = part;
      } else {
        current = test;
      }
    }
    if (current.trim()) segments.push(current);
    return segments.length ? segments : [text];
  }

  private splitOnSentences(text: string): string[] {
    return this.merge(text, text.split(/(?<=[.!?])\s+(?=\S)|(?<=[.!?])(?=\[\[)/));
  }

  private splitOnPunctuation(text: string): string[] {
    return this.merge(text, text.split(/(?<=[;:,])\s+(?=\S)|(?<=[;:,])(?=\[\[)/));
  }

  private splitOnNewlines(text: string): string[] {
    return this.merge(text, text.split('\n'), '\n');
  }

  private forceSplitAtTokens(text: string): string[] {
    const segments: string[] = [];
    let remaining = text;
    while (remaining) {
      if (countTokens(remaining) <= this.maxTokens) {
        segments.push(remaining);
        break;
      }
      // Binary search for the longest prefix that fits.
      let left = 0;
      let right = remaining.length;
      let best = left;
      while (left <= right) {
        const mid = Math.floor((left + right) / 2);
        if (countTokens(remaining.slice(0, mid)) <= this.maxTokens) {
          best = mid;
          left = mid + 1;
        } else {
          right = mid - 1;
        }
      }
      let splitPos = findWordBoundaryNear(remaining, best);
      if (splitPos === 0) splitPos = Math.max(1, best);
      segments.push(remaining.slice(0, splitPos));
      remaining = remaining.slice(splitPos).trimStart();
    }
    return segments;
  }
}

function findWordBoundaryNear(text: string, pos: number): number {
  if (pos >= text.length) return text.length;
  const isSpace = (c: string) => c === ' ' || c === '\n' || c === '\t';
  for (let i = pos; i > Math.max(0, pos - 50); i--) if (isSpace(text[i])) return i + 1;
  for (let i = pos; i < Math.min(text.length, pos + 50); i++) if (isSpace(text[i])) return i + 1;
  return pos;
}

// --- PlaceholderRenumberer -----------------------------------------------------------

export function createChunkWithLocalPlaceholders(
  text: string,
  globalTagMap: Record<string, string>,
  globalOffset: number,
): HtmlChunk {
  const localTagMap: Record<string, string> = {};
  const globalIndices: number[] = [];
  let out = '';
  let last = 0;

  // Every occurrence gets its own local index, even a global placeholder that repeats.
  findAllPlaceholders(text).forEach((m, local) => {
    const localPlaceholder = createPlaceholder(local);
    out += text.slice(last, m.start) + localPlaceholder;
    last = m.end;
    localTagMap[localPlaceholder] = globalTagMap[m.placeholder] ?? '';
    globalIndices.push(m.index);
  });
  out += text.slice(last);

  return { text: out, localTagMap, globalOffset, globalIndices };
}

// --- HtmlChunker ---------------------------------------------------------------------

export function chunkHtmlWithPlaceholders(
  text: string,
  tagMap: Record<string, string>,
  maxTokens = 450,
): HtmlChunk[] {
  if (!text || !text.trim()) return [];
  const splitter = new TextSplitter(maxTokens);

  // Safe split points: after a block closing tag that is directly followed by a block opening tag.
  const placeholders = findAllPlaceholders(text);
  const points: number[] = [];
  placeholders.forEach((p, i) => {
    if (!isBlockClosingTag(tagMap[p.placeholder] ?? '')) return;
    const next = placeholders[i + 1];
    if (next && isBlockOpeningTag(tagMap[next.placeholder] ?? '')) points.push(p.end);
  });

  const segments: string[] = [];
  if (!points.length) {
    segments.push(text);
  } else {
    let prev = 0;
    for (const point of points) {
      if (point > prev) segments.push(text.slice(prev, point));
      prev = point;
    }
    if (prev < text.length) segments.push(text.slice(prev));
  }
  const nonEmpty = segments.filter((s) => s.trim());

  const chunks: HtmlChunk[] = [];
  let current: string[] = [];
  let currentTokens = 0;
  let globalOffset = 0;

  const finalize = () => {
    const chunk = createChunkWithLocalPlaceholders(current.join(''), tagMap, globalOffset);
    chunks.push(chunk);
    globalOffset += Object.keys(chunk.localTagMap).length;
  };
  const exceeds = (extra: number) => currentTokens + extra > maxTokens;

  for (const segment of nonEmpty) {
    const tokens = countTokens(segment);
    if (tokens > maxTokens) {
      if (current.length) {
        finalize();
        current = [];
        currentTokens = 0;
      }
      for (const sub of splitter.splitOversizedSegment(segment)) {
        const subTokens = countTokens(sub);
        if (exceeds(subTokens) && current.length) {
          finalize();
          current = [sub];
          currentTokens = subTokens;
        } else {
          current.push(sub);
          currentTokens += subTokens;
        }
      }
    } else if (exceeds(tokens) && current.length) {
      finalize();
      current = [segment];
      currentTokens = tokens;
    } else {
      current.push(segment);
      currentTokens += tokens;
    }
  }
  if (current.length) finalize();
  return chunks;
}
