// Port of src/core/epub/token_alignment_fallback.py and the helpers it relies on in
// html_utils.py: when the model cannot keep placeholders, translate the text without
// them and reinsert each placeholder at its proportional position.

import { createPlaceholder, findAllPlaceholders, removeAllPlaceholders } from './placeholders';

const BOUNDARIES = ' \t\n\r.,;:!?、。，：？！';

function nearestWordBoundary(text: string, pos: number): number {
  if (pos <= 0) return 0;
  if (pos >= text.length) return text.length;
  if (BOUNDARIES.includes(text[pos])) return pos;

  let left = pos;
  let right = pos;
  while (left > 0 && !BOUNDARIES.includes(text[left])) left--;
  while (right < text.length && !BOUNDARIES.includes(text[right])) right++;
  return pos - left <= right - pos ? left : right;
}

const placeholderIndex = (ph: string) => Number.parseInt(/\d+/.exec(ph)?.[0] ?? '0', 10);

/** Inserts each placeholder at its position, same-position ones in index order, end to start. */
function insertAt(text: string, insertions: Array<[number, string]>): string {
  const groups = new Map<number, string[]>();
  for (const [pos, ph] of insertions) groups.set(pos, [...(groups.get(pos) ?? []), ph]);
  let result = text;
  for (const pos of [...groups.keys()].sort((a, b) => b - a)) {
    const combined = groups.get(pos)!.sort((a, b) => placeholderIndex(a) - placeholderIndex(b)).join('');
    result = result.slice(0, pos) + combined + result.slice(pos);
  }
  return result;
}

export function alignAndInsertPlaceholders(
  original: string,
  translatedWithoutPlaceholders: string,
  placeholders: string[],
): string {
  // Offset of each placeholder within the original text with all placeholders removed.
  const positions: Array<[number, string]> = [];
  let searchFrom = 0;
  let removed = 0;
  for (const ph of placeholders) {
    const idx = original.indexOf(ph, searchFrom);
    if (idx !== -1) {
      positions.push([idx - removed, ph]);
      searchFrom = idx + ph.length;
      removed += ph.length;
    }
  }

  let clean = original;
  for (const ph of placeholders) clean = clean.split(ph).join('');

  let relative: Array<[number, string]>;
  if (clean.length === 0) {
    if (!positions.length) return translatedWithoutPlaceholders;
    const step = 1 / Math.max(1, positions.length + 1);
    relative = positions.map(([, ph], i) => [i * step, ph]);
  } else {
    relative = positions.map(([pos, ph]) => [Math.min(1, Math.max(0, pos / clean.length)), ph]);
  }

  const length = translatedWithoutPlaceholders.length;
  const absolute: Array<[number, string]> = relative.map(([rel, ph]) => [
    nearestWordBoundary(translatedWithoutPlaceholders, Math.trunc(rel * length)),
    ph,
  ]);
  return insertAt(translatedWithoutPlaceholders, absolute);
}

// html_utils.extract_text_and_positions / reinsert_placeholders (kept for parity tests).

export function extractTextAndPositions(textWithPlaceholders: string): { text: string; positions: Map<number, number> } {
  const text = removeAllPlaceholders(textWithPlaceholders);
  const positions = new Map<number, number>();
  const matches = findAllPlaceholders(textWithPlaceholders);
  if (!text.length) {
    matches.forEach((m, i) => positions.set(m.index, i / Math.max(1, matches.length)));
    return { text: '', positions };
  }
  for (const m of matches) {
    positions.set(m.index, removeAllPlaceholders(textWithPlaceholders.slice(0, m.start)).length / text.length);
  }
  return { text, positions };
}

const WIDE_BOUNDARIES = ' \t\n\r              　.,;:!?、。，：；？！';

function findNearestWordBoundary(text: string, pos: number): number {
  if (pos <= 0) return 0;
  if (pos >= text.length) return text.length;
  if (WIDE_BOUNDARIES.includes(text[pos])) return pos;
  let left = pos;
  let right = pos;
  while (left > 0 && !WIDE_BOUNDARIES.includes(text[left])) left--;
  while (right < text.length && !WIDE_BOUNDARIES.includes(text[right])) right++;
  return pos - left <= right - pos ? left : right;
}

export function reinsertPlaceholders(translated: string, positions: Map<number, number>): string {
  if (!positions.size) return translated;
  const insertions: Array<[number, number]> = [...positions].map(([idx, rel]) => [
    findNearestWordBoundary(translated, Math.trunc(rel * translated.length)),
    idx,
  ]);
  // Later positions first so earlier offsets stay valid; same position in ascending index order.
  insertions.sort((a, b) => b[0] - a[0] || a[1] - b[1]);
  let result = translated;
  for (const [pos, idx] of insertions) result = result.slice(0, pos) + createPlaceholder(idx) + result.slice(pos);
  return result;
}

/** Last resort used when alignment throws: proportional reinsertion. */
export function fallbackProportional(original: string, translated: string): string {
  return reinsertPlaceholders(translated, extractTextAndPositions(original).positions);
}
