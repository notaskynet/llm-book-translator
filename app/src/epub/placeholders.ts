// Ports of src/common/placeholder_format.py, PlaceholderValidator.validate_strict,
// PlaceholderManager.restore_to_global and html_utils.is_text_free_chunk.
// Placeholders are always the unified `[idN]` format.

import { PLACEHOLDER_PREFIX, PLACEHOLDER_SUFFIX } from '../config';

export const PLACEHOLDER_PATTERN = /\[id(\d+)\]/g;

export interface PlaceholderMatch {
  start: number;
  end: number;
  placeholder: string;
  index: number;
}

export function createPlaceholder(index: number): string {
  return `${PLACEHOLDER_PREFIX}${index}${PLACEHOLDER_SUFFIX}`;
}

export function parsePlaceholder(placeholder: string): number | null {
  const m = /^\[id(\d+)\]/.exec(placeholder);
  return m ? Number.parseInt(m[1], 10) : null;
}

export function findAllPlaceholders(text: string): PlaceholderMatch[] {
  return [...text.matchAll(PLACEHOLDER_PATTERN)].map((m) => ({
    start: m.index!,
    end: m.index! + m[0].length,
    placeholder: m[0],
    index: Number.parseInt(m[1], 10),
  }));
}

export function removeAllPlaceholders(text: string): string {
  return text.replace(PLACEHOLDER_PATTERN, '');
}

/** Converts a chunk's local indices (0, 1, 2...) back to document-global ones. */
export function restoreToGlobal(translated: string, globalIndices: number[]): string {
  if (!globalIndices.length) return translated;
  let result = translated;
  // Two passes through temporary markers so a renumbering never feeds on its own output.
  globalIndices.forEach((_, local) => {
    const ph = createPlaceholder(local);
    if (result.includes(ph)) result = result.split(ph).join(`__RESTORE_${local}__`);
  });
  globalIndices.forEach((global, local) => {
    result = result.split(`__RESTORE_${local}__`).join(createPlaceholder(global));
  });
  return result;
}

/**
 * Strict check: the right count, sequential 0..n-1, and every expected placeholder present.
 * Returns an error message, or '' when valid.
 */
export function validatePlaceholdersStrict(text: string, expected: Record<string, string>): string {
  const keys = Object.keys(expected);
  if (!keys.length) return '';

  const first = /^(.*?)(\d+)(.*)$/.exec(keys[0]);
  if (!first) return `Invalid placeholder format: ${keys[0]}`;

  const found = findAllPlaceholders(text).map((m) => m.index);
  if (found.length !== keys.length) {
    return `Placeholder count mismatch: expected ${keys.length}, found ${found.length}`;
  }
  const sorted = [...found].sort((a, b) => a - b);
  if (sorted.some((v, i) => v !== i)) return 'Non-sequential placeholders.';
  for (const key of keys) if (!text.includes(key)) return `Missing placeholder: ${key}`;
  return '';
}

export const validatePlaceholders = (text: string, expected: Record<string, string>): boolean =>
  validatePlaceholdersStrict(text, expected) === '';

const UNICODE_LETTER = /\p{L}/u;

/** True when the chunk carries no translatable letters, so it passes through verbatim. */
export function isTextFreeChunk(chunkText: string): boolean {
  if (!chunkText) return true;
  return !UNICODE_LETTER.test(removeAllPlaceholders(chunkText));
}
