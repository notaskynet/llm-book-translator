// Building the extracts for Sample & Compare (the item construction of
// src/api/blueprints/sample_routes.py). Deterministic: the same file always yields the same
// units, so an index picked earlier stays valid.

import { DEFAULT_MAX_TOKENS_PER_CHUNK, SRT_LINES_PER_BLOCK } from '../config';
import { TokenChunker, initTokenizer } from '../chunking/tokenChunker';
import { extractParagraphs } from '../documents/sampler';
import { parseSrt } from '../formats/srtProcessor';
import { capChunkText, selectSampleIndices } from './select';

export interface SourceUnit {
  mainContent: string;
  contextBefore: string;
  contextAfter: string;
}

export interface SampleItem {
  /** Position of the extract among the document's units. */
  index: number;
  sourceText: string;
  truncated: boolean;
  contextBefore: string;
  contextAfter: string;
}

export interface SampleWarning {
  total: number;
  count: number;
  requested: number;
}

export class DocumentTooSmallError extends Error {
  constructor() {
    super('document too small for sampling');
  }
}

const extensionOf = (name: string) => name.slice(name.lastIndexOf('.')).toLowerCase();

/** SRT cues grouped into blocks of text (no markers), or the chunks of a text document. */
export async function loadSourceUnits(file: { name: string; arrayBuffer(): Promise<ArrayBuffer> }): Promise<SourceUnit[]> {
  const data = await file.arrayBuffer();
  const ext = extensionOf(file.name);

  if (ext === '.srt') {
    const subtitles = parseSrt(new TextDecoder().decode(data));
    if (!subtitles.length) throw new Error('No subtitles found in SRT file');
    const blocks: string[] = [];
    for (let i = 0; i < subtitles.length; i += SRT_LINES_PER_BLOCK) {
      const text = subtitles.slice(i, i + SRT_LINES_PER_BLOCK).map((s) => s.text).filter(Boolean).join('\n');
      if (text.trim()) blocks.push(text);
    }
    return blocks.map((mainContent, i) => ({
      mainContent, contextBefore: blocks[i - 1] ?? '', contextAfter: blocks[i + 1] ?? '',
    }));
  }

  const text = await extractParagraphs(ext, data);
  if (!text?.trim()) throw new Error('File is empty or unreadable');
  await initTokenizer();
  return new TokenChunker(DEFAULT_MAX_TOKENS_PER_CHUNK).chunkText(text).map((c) => ({
    mainContent: c.mainContent, contextBefore: c.contextBefore, contextAfter: c.contextAfter,
  }));
}

export function itemsForIndices(units: SourceUnit[], indices: number[], maxChars: number): SampleItem[] {
  return indices
    .filter((i) => i >= 0 && i < units.length)
    .map((index) => {
      const unit = units[index];
      const [sourceText, truncated] = capChunkText(unit.mainContent, maxChars);
      return { index, sourceText, truncated, contextBefore: unit.contextBefore, contextAfter: unit.contextAfter };
    });
}

/** The initial `n` extracts. Throws DocumentTooSmallError below three units. */
export function initialSamples(units: SourceUnit[], n: number, maxChars: number): { items: SampleItem[]; warning: SampleWarning | null } {
  if (units.length < 3) throw new DocumentTooSmallError();
  const indices = selectSampleIndices(units.length, n);
  return {
    items: itemsForIndices(units, indices, maxChars),
    warning: indices.length < n ? { total: units.length, count: indices.length, requested: n } : null,
  };
}

/** A random interior index not in `exclude`, or null when all are used. */
export function pickRandomUnusedIndex(total: number, exclude: ReadonlySet<number>, random: () => number = Math.random): number | null {
  if (total < 3) return null;
  const available: number[] = [];
  for (let i = 1; i <= total - 2; i++) if (!exclude.has(i)) available.push(i);
  return available.length ? available[Math.floor(random() * available.length)] : null;
}
