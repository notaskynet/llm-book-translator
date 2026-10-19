/**
 * Normalizes a language name to a lowercase base key for table lookups, so
 * "Portuguese (Brazil)" and "Portuguese (Portugal)" both map to "portuguese".
 * Port of src/utils/lang_normalize.py.
 */
export function normalizeLangKey(language: string): string {
  if (!language) return '';
  return language.replace(/\s*\([^)]*\)\s*/g, '').trim().toLowerCase();
}

/** Python's str.title(): uppercase the first letter of each word, lowercase the rest. */
export function pythonTitle(s: string): string {
  return s.replace(/[\p{L}\p{N}]+/gu, (w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase());
}
