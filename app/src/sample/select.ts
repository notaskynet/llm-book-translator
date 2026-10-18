// Port of src/core/sampling.py: choosing representative chunks for Sample & Compare. Pure logic.

import { SENTENCE_TERMINATORS } from '../config';
import { roundHalfEven } from '../lib/pyRound';

/**
 * Up to `n` indices spread evenly over the interior chunks `[1, total - 2]`, so a title page or
 * trailing metadata is never picked. Throws for a document with no interior.
 */
export function selectSampleIndices(totalChunks: number, n: number): number[] {
  if (n < 1) throw new Error('n must be >= 1');
  if (totalChunks < 3) throw new Error('document too small for sampling');

  const lo = 1;
  const hi = totalChunks - 2;
  if (hi - lo + 1 <= n) return Array.from({ length: hi - lo + 1 }, (_, i) => lo + i);

  const seen = new Set<number>();
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const idx = Math.max(lo, Math.min(hi, roundHalfEven(((i + 1) * (totalChunks - 1)) / (n + 1))));
    if (!seen.has(idx)) { seen.add(idx); out.push(idx); }
  }
  return out;
}

/**
 * Caps `text` near `maxChars` without cutting a sentence: at the last boundary within the budget,
 * else at the first boundary after it, else (no boundary at all) the whole text. `maxChars` is a
 * soft target.
 */
export function capChunkText(text: string, maxChars: number): [string, boolean] {
  if (maxChars <= 0) throw new Error('max_chars must be > 0');
  if (text.length <= maxChars) return [text, false];

  const window = text.slice(0, maxChars);
  let bestCut = -1;
  for (const term of SENTENCE_TERMINATORS) {
    const idx = window.lastIndexOf(term);
    if (idx >= 0) bestCut = Math.max(bestCut, idx + term.length);
  }
  if (bestCut > 0) return [window.slice(0, bestCut).trimEnd(), true];

  const after = text.slice(maxChars);
  let bestAfter = -1;
  let bestTermLength = 0;
  for (const term of SENTENCE_TERMINATORS) {
    const idx = after.indexOf(term);
    if (idx >= 0 && (bestAfter === -1 || idx < bestAfter)) { bestAfter = idx; bestTermLength = term.length; }
  }
  if (bestAfter >= 0) return [text.slice(0, maxChars + bestAfter + bestTermLength).trimEnd(), true];
  return [text, false];
}
