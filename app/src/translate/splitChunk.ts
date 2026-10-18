import { SENTENCE_TERMINATORS } from '../config';

const endsWithTerminator = (s: string) => SENTENCE_TERMINATORS.some((t) => s.endsWith(t));

/**
 * Splits a chunk in two for a retry after a context overflow, preferably at a
 * sentence boundary near `targetRatio`. Port of split_chunk_for_retry (translator.py).
 */
export function splitChunkForRetry(mainContent: string, targetRatio = 0.5): [string, string] {
  if (!mainContent.trim()) return [mainContent, ''];

  const lines = mainContent.split('\n');
  if (lines.length <= 1) {
    const targetPos = Math.trunc(mainContent.length * targetRatio);
    let bestSplit = targetPos;
    for (const terminator of SENTENCE_TERMINATORS) {
      const searchStart = Math.max(0, targetPos - 100);
      const searchEnd = Math.min(mainContent.length, targetPos + 100);
      const termPos = mainContent.slice(searchStart, searchEnd).lastIndexOf(terminator);
      if (termPos !== -1) {
        const actualPos = searchStart + termPos + terminator.length;
        if (Math.abs(actualPos - targetPos) < Math.abs(bestSplit - targetPos)) bestSplit = actualPos;
      }
    }
    return [mainContent.slice(0, bestSplit).trim(), mainContent.slice(bestSplit).trim()];
  }

  const targetLine = Math.trunc(lines.length * targetRatio);
  let bestLine = targetLine;
  for (let i = Math.max(0, targetLine - 5); i < Math.min(lines.length, targetLine + 5); i++) {
    const stripped = lines[i].trim();
    if (stripped && endsWithTerminator(stripped)) {
      bestLine = i + 1;
      break;
    }
  }
  return [lines.slice(0, bestLine).join('\n').trim(), lines.slice(bestLine).join('\n').trim()];
}
