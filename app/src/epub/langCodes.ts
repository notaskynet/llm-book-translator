// Port of get_language_code (src/core/epub/lang_support.py). The name table is exported
// from the Python implementation by tests/standalone/dump_ts_fixtures.py.

import data from './data/language-codes.json';

const NAMES = data.names as Record<string, string>;
const REGIONAL = data.regional as Record<string, string>;
const KNOWN_CODES = new Set(Object.values(NAMES));

/** Resolves a language name or locale to a BCP 47 code ("French" -> "fr"), or null. */
export function getLanguageCode(language: string | null | undefined): string | null {
  if (!language) return null;
  const lower = language.toLowerCase().trim();
  if (!lower) return null;
  if (lower in REGIONAL) return REGIONAL[lower];
  if (lower in NAMES) return NAMES[lower];
  const base = lower.split('-')[0];
  if (KNOWN_CODES.has(base)) return base;
  if (base in NAMES) return NAMES[base];
  return null;
}
