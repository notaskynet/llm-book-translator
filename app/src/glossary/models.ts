// Port of src/core/glossary/models.py.

export const GENDER_MALE = 'male';
export const GENDER_FEMALE = 'female';
export type Gender = typeof GENDER_MALE | typeof GENDER_FEMALE;

/** Cap on the cast block; it is injected into every chunk, so it is a permanent token tax. */
export const DEFAULT_MAX_CAST_ENTRIES = 80;

const MALE = new Set(['male', 'm', 'man', 'boy', 'masculine', 'masc', 'male.']);
const FEMALE = new Set(['female', 'f', 'woman', 'girl', 'feminine', 'fem', 'female.']);

/** Coerces common spellings to 'male' or 'female'; anything else (incl. 'unknown') is null. */
export function normalizeGender(value: unknown): Gender | null {
  if (value == null) return null;
  const text = String(value).trim().toLowerCase();
  if (MALE.has(text)) return GENDER_MALE;
  if (FEMALE.has(text)) return GENDER_FEMALE;
  return null;
}

export interface GlossaryTerm {
  source: string;
  target: string;
  category?: string | null;
  gender?: Gender | null;
}

export interface Glossary {
  id?: number;
  name: string;
  sourceLanguage: string;
  targetLanguage: string;
  terms: GlossaryTerm[];
  updatedAt: number;
}

export interface GlossaryConfig {
  maxEntries: number;
  caseSensitive: boolean;
  warnOnCap: boolean;
  maxCastEntries: number;
}

export const DEFAULT_GLOSSARY_CONFIG: GlossaryConfig = {
  maxEntries: 50,
  caseSensitive: true,
  warnOnCap: true,
  maxCastEntries: DEFAULT_MAX_CAST_ENTRIES,
};

export type TermMetadata = Record<string, { category?: string; gender?: string }>;

/** {source: target} for the filter; entries without a source are dropped. */
export const termsMap = (terms: GlossaryTerm[]): Map<string, string> =>
  new Map(terms.filter((t) => t.source).map((t) => [t.source, t.target]));

/** {source: {category, gender}}, only for terms that carry some metadata. */
export function termsMetadata(terms: GlossaryTerm[]): TermMetadata {
  const meta: TermMetadata = {};
  for (const t of terms) {
    if (!t.source) continue;
    const entry: { category?: string; gender?: string } = {};
    if (t.category) entry.category = t.category;
    if (t.gender) entry.gender = t.gender;
    if (Object.keys(entry).length) meta[t.source] = entry;
  }
  return meta;
}
