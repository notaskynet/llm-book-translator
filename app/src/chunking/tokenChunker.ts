// Port of src/core/chunking/token_chunker.py: token-based chunking that respects
// paragraph and sentence boundaries. Same cl100k_base encoding as the Python side.

import { Tiktoken } from 'js-tiktoken/lite';
import cl100k_base from 'js-tiktoken/ranks/cl100k_base';
import { SENTENCE_TERMINATORS } from '../config';

let encoder: Tiktoken | undefined;
function getEncoder(): Tiktoken {
  return (encoder ??= new Tiktoken(cl100k_base));
}

export function countTokens(text: string): number {
  if (!text) return 0;
  // Special-token text is ordinary content in a book, never a control sequence.
  return getEncoder().encode(text, [], []).length;
}

export interface RawChunk {
  text: string;
  /** Separator that re-attaches this chunk to the previous one on reassembly. */
  joinBefore: string;
}

export interface Chunk {
  contextBefore: string;
  mainContent: string;
  contextAfter: string;
  /** Separator that re-attaches this chunk to the previous one ("" for the first). */
  joinWith: string;
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const TERMINATOR_PATTERN = new RegExp(
  [...SENTENCE_TERMINATORS].sort((a, b) => b.length - a.length).map(escapeRegExp).join('|'),
  'g',
);

export class TokenChunker {
  readonly maxTokens: number;
  readonly softLimit: number;

  constructor(maxTokens = 800, softLimitRatio = 0.8) {
    this.maxTokens = maxTokens;
    this.softLimit = Math.trunc(maxTokens * softLimitRatio);
  }

  countTokens(text: string): number {
    return countTokens(text);
  }

  splitIntoParagraphs(text: string): string[] {
    return text.split(/\n\s*\n/).filter((p) => p.trim());
  }

  splitParagraphIntoSentences(paragraph: string): string[] {
    const sentences: string[] = [];
    let lastEnd = 0;
    for (const match of paragraph.matchAll(TERMINATOR_PATTERN)) {
      const end = match.index! + match[0].length;
      const sentence = paragraph.slice(lastEnd, end).trim();
      if (sentence) sentences.push(sentence);
      lastEnd = end;
    }
    const remaining = paragraph.slice(lastEnd).trim();
    if (remaining) sentences.push(remaining);
    if (!sentences.length && paragraph.trim()) sentences.push(paragraph.trim());
    return sentences;
  }

  /** Splits on single newlines, dropping blank lines (one-paragraph-per-line books). */
  static splitParagraphIntoLines(paragraph: string): string[] {
    return paragraph.split('\n').filter((l) => l.trim()).map((l) => l.trimEnd());
  }

  private edgeContext(chunkText: string, last: boolean): string {
    const paragraphs = this.splitIntoParagraphs(chunkText);
    if (!paragraphs.length) return '';
    const edge = last ? paragraphs[paragraphs.length - 1] : paragraphs[0];
    const lines = TokenChunker.splitParagraphIntoLines(edge);
    if (lines.length > 1) return last ? lines[lines.length - 1] : lines[0];
    return edge;
  }

  private chunkUnits(units: string[], separator = '\n\n'): RawChunk[] {
    const minChunkTokens = Math.trunc(this.maxTokens * 0.25);
    const chunks: RawChunk[] = [];
    let currentUnits: string[] = [];
    let currentTokens = 0;
    const save = (parts: string[]) => chunks.push({ text: parts.join(separator), joinBefore: separator });

    for (const unit of units) {
      const unitTokens = this.countTokens(unit);

      if (unitTokens > this.maxTokens) {
        let prefixUnits: string[] = [];
        if (currentUnits.length && currentTokens < minChunkTokens) {
          prefixUnits = currentUnits;
          currentUnits = [];
          currentTokens = 0;
        } else if (currentUnits.length) {
          save(currentUnits);
          currentUnits = [];
          currentTokens = 0;
        }

        const lines = TokenChunker.splitParagraphIntoLines(unit);
        const [subUnits, subSeparator] =
          lines.length > 1 ? [lines, '\n'] : [this.splitParagraphIntoSentences(unit), ' '];
        if (subUnits.length > 1) {
          const sentenceChunks = this.chunkUnits(subUnits, subSeparator);

          if (prefixUnits.length && sentenceChunks.length) {
            const prefixText = prefixUnits.join(separator);
            const prefixTokens = this.countTokens(prefixText);
            const firstChunkTokens = this.countTokens(sentenceChunks[0].text);
            if (prefixTokens + firstChunkTokens <= this.maxTokens) {
              sentenceChunks[0].text = prefixText + separator + sentenceChunks[0].text;
            } else {
              chunks.push({ text: prefixText, joinBefore: separator });
            }
          } else if (prefixUnits.length) {
            save(prefixUnits);
          }

          // The run starts a new paragraph; only chunks 2..n are continuations.
          if (sentenceChunks.length) sentenceChunks[0].joinBefore = separator;
          chunks.push(...sentenceChunks);
        } else if (prefixUnits.length) {
          chunks.push({ text: prefixUnits.join(separator) + separator + unit, joinBefore: separator });
        } else {
          chunks.push({ text: unit, joinBefore: separator });
        }
        continue;
      }

      let potentialTokens = currentTokens + unitTokens;
      if (currentUnits.length) potentialTokens += this.countTokens(separator);

      if (currentTokens >= this.softLimit && potentialTokens > this.maxTokens) {
        save(currentUnits);
        currentUnits = [unit];
        currentTokens = unitTokens;
      } else if (potentialTokens > this.maxTokens) {
        if (currentUnits.length) save(currentUnits);
        currentUnits = [unit];
        currentTokens = unitTokens;
      } else {
        currentUnits.push(unit);
        currentTokens = potentialTokens;
      }
    }

    if (currentUnits.length) save(currentUnits);
    return chunks;
  }

  chunkText(text: string): Chunk[] {
    if (!text || !text.trim()) return [];
    const paragraphs = this.splitIntoParagraphs(text);
    if (!paragraphs.length) return [];
    const rawChunks = this.chunkUnits(paragraphs, '\n\n');
    if (!rawChunks.length) return [];

    return rawChunks.map((raw, i) => ({
      contextBefore: i > 0 ? this.edgeContext(rawChunks[i - 1].text, true) : '',
      mainContent: raw.text,
      contextAfter: i < rawChunks.length - 1 ? this.edgeContext(rawChunks[i + 1].text, false) : '',
      joinWith: i === 0 ? '' : raw.joinBefore,
    }));
  }
}
