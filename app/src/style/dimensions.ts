// Port of src/core/style/dimensions.py: the closed list of writing-style dimensions.

export const ALLOWED_DIMENSIONS = [
  'register', 'narrative_voice', 'sentence_rhythm', 'lexicon', 'imagery',
  'dialogue', 'punctuation', 'formatting', 'other',
] as const;

export type Dimension = (typeof ALLOWED_DIMENSIONS)[number];
export const DEFAULT_DIMENSION: Dimension = 'other';
