// Port of src/utils/document_sampler.py: readable text out of a document, carved into a bounded
// number of representative excerpts. Used by NER and style extraction.

import JSZip from 'jszip';
import { findBody, parseXhtmlDocument, parseXml } from '../epub/dom';
import { dirname, joinPath, unquote } from '../epub/zipUtils';

export const TEXT_EXTS = ['.txt', '.srt'];
export const SUPPORTED_EXTS = [...TEXT_EXTS, '.epub'];
/** Hard cap on text pulled from one file before sampling. */
export const FULL_TEXT_CAP = 5_000_000;
/** Visible separator between non-contiguous excerpts; the model reads it as a discontinuity. */
export const EXCERPT_SEPARATOR = '\n\n[…]\n\n';

const extensionOf = (name: string) => {
  const dot = name.lastIndexOf('.');
  return dot === -1 ? '' : name.slice(dot).toLowerCase();
};

async function extractEpubText(data: ArrayBuffer | Uint8Array, hardCap: number): Promise<string | null> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(data);
  } catch {
    return null;
  }

  let ordered: string[] = [];
  try {
    const container = parseXml((await zip.file('META-INF/container.xml')?.async('string')) ?? '');
    const opfPath = container?.getElementsByTagName('rootfile')[0]?.getAttribute('full-path');
    const opf = opfPath ? parseXml((await zip.file(opfPath)?.async('string')) ?? '') : null;
    if (opfPath && opf) {
      const manifest = new Map<string, string>();
      for (const item of Array.from(opf.getElementsByTagName('item'))) {
        const type = item.getAttribute('media-type') ?? '';
        if (item.getAttribute('id') && item.getAttribute('href') && ['application/xhtml+xml', 'text/html'].includes(type)) {
          manifest.set(item.getAttribute('id')!, item.getAttribute('href')!);
        }
      }
      for (const itemref of Array.from(opf.getElementsByTagName('itemref'))) {
        const href = manifest.get(itemref.getAttribute('idref') ?? '');
        if (href) ordered.push(joinPath(dirname(opfPath), unquote(href)));
      }
    }
  } catch {
    ordered = [];
  }
  if (!ordered.length) ordered = Object.keys(zip.files).filter((n) => /\.(xhtml|html|htm)$/i.test(n)).sort();

  const parts: string[] = [];
  let running = 0;
  for (const name of ordered) {
    const content = await zip.file(name)?.async('string');
    const doc = content ? parseXhtmlDocument(content) : null;
    const body = doc && findBody(doc);
    const text = body?.textContent?.replace(/\s+/g, ' ').trim();
    if (!text) continue;
    parts.push(text);
    running += text.length;
    if (running >= hardCap) break;
  }
  return parts.length ? parts.join('\n\n').slice(0, hardCap) : null;
}

/** The full readable text of a file (capped), or null when unsupported or unreadable. */
export async function extractFullText(file: File | { name: string; arrayBuffer(): Promise<ArrayBuffer> }, hardCap = FULL_TEXT_CAP): Promise<string | null> {
  const ext = extensionOf(file.name);
  if (!SUPPORTED_EXTS.includes(ext) || hardCap <= 0) return null;
  const data = await file.arrayBuffer();
  if (ext === '.epub') return extractEpubText(data, hardCap);
  return new TextDecoder('utf-8').decode(data).replace(/^﻿/, '').slice(0, hardCap);
}

/** Python's round(): halves go to the even neighbour. */
function roundHalfEven(x: number): number {
  const floor = Math.floor(x);
  const diff = x - floor;
  if (diff < 0.5) return floor;
  if (diff > 0.5) return floor + 1;
  return floor % 2 === 0 ? floor : floor + 1;
}

const rfind = (text: string, sub: string, lo: number, hi: number) => {
  const i = text.slice(lo, hi).lastIndexOf(sub);
  return i === -1 ? -1 : lo + i;
};
const find = (text: string, sub: string, lo: number, hi: number) => {
  const i = text.slice(lo, hi).indexOf(sub);
  return i === -1 ? -1 : lo + i;
};

/**
 * `[joinedExcerpts, effectiveCount]`. Short texts come back untouched; the count is clamped so
 * each excerpt keeps at least `minSampleSize` characters, and edges snap to nearby spaces.
 */
export function takeDistributedSamples(
  text: string,
  totalBudget: number,
  numSamples: number,
  minSampleSize = 500,
  separator = EXCERPT_SEPARATOR,
): [string, number] {
  let n = Math.max(1, Math.trunc(numSamples));
  const length = text.length;

  if (length <= totalBudget) return [text, 1];
  if (n === 1) return [text.slice(0, totalBudget), 1];

  const maxForBudget = Math.max(1, Math.floor(totalBudget / minSampleSize));
  if (n > maxForBudget) n = maxForBudget;
  if (n <= 1) return [text.slice(0, totalBudget), 1];

  const sampleSize = Math.floor(totalBudget / n);
  if (sampleSize * n >= length) return [text.slice(0, totalBudget), 1];

  const stride = (length - sampleSize) / (n - 1);
  const pieces: string[] = [];
  let lastEnd = -1;
  for (let i = 0; i < n; i++) {
    let start = roundHalfEven(i * stride);
    let end = start + sampleSize;

    if (start > 0 && start < length) {
      const ws = rfind(text, ' ', Math.max(0, start - 80), start + 1);
      if (ws !== -1) start = ws + 1;
    }
    if (end < length) {
      const ws = find(text, ' ', end, Math.min(length, end + 80));
      if (ws !== -1) end = ws;
    }
    if (start <= lastEnd) start = lastEnd + 1;
    if (start >= length || end <= start) continue;

    const chunk = text.slice(start, end).trim();
    if (chunk) {
      pieces.push(chunk);
      lastEnd = end;
    }
  }
  return pieces.length ? [pieces.join(separator), pieces.length] : [text.slice(0, totalBudget), 1];
}
