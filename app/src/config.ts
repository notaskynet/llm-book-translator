// Constants ported from src/config.py. Values are the Python defaults; the
// static app has no .env, so anything user-tunable lives in the settings store.

export const TRANSLATE_TAG_IN = '<TRANSLATION>';
export const TRANSLATE_TAG_OUT = '</TRANSLATION>';
export const INPUT_TAG_IN = '<SOURCE_TEXT>';
export const INPUT_TAG_OUT = '</SOURCE_TEXT>';

export const PLACEHOLDER_PREFIX = '[id';
export const PLACEHOLDER_SUFFIX = ']';

export function createPlaceholder(n: number, prefix = PLACEHOLDER_PREFIX, suffix = PLACEHOLDER_SUFFIX): string {
  return `${prefix}${n}${suffix}`;
}

export const SENTENCE_TERMINATORS: readonly string[] = [
  '.', '!', '?', '."', '?"', '!"', '."', ".'", "?'", "!'", ':', '.)',
  // Full-width CJK terminators, with the closing quotes that commonly follow them.
  '。', '！', '？',
  '。”', '！”', '？”',
  '。」', '！」', '？」',
  '。』', '！』', '？』',
];

export const MAX_TRANSLATION_ATTEMPTS = 2;
export const REQUEST_TIMEOUT_MS = 300_000;
export const DEFAULT_MAX_TOKENS_PER_CHUNK = 450;

// Chunk reduction after a context overflow (src/core/translator.py).
export const MAX_CHUNK_REDUCTION_ATTEMPTS = 3;
export const CHUNK_REDUCTION_FACTOR = 0.6;
export const MIN_CHUNK_CHARACTERS = 200;
