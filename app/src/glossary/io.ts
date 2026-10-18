// Glossary import/export, compatible with the files the Python app reads and writes
// (src/api/blueprints/glossary_routes.py): CSV with a header row, or JSON.

import Papa from 'papaparse';
import { normalizeGender, type Glossary, type GlossaryTerm } from './models';

/** Outcome of replacing a glossary's terms, so the UI can explain why N < rows in the file. */
export interface ReplaceResult {
  inserted: number;
  skippedEmpty: number;
  skippedDuplicate: number;
  totalInput: number;
}

const clean = (v: unknown) => (v == null ? '' : String(v).trim());

function toTerm(entry: Record<string, unknown>): GlossaryTerm | null {
  const source = clean(entry.source ?? entry.source_term);
  if (!source) return null;
  return {
    source,
    target: clean(entry.target ?? entry.translated_term),
    category: clean(entry.category) || null,
    gender: normalizeGender(entry.gender ?? entry.sex),
  };
}

export function termsFromCsv(text: string): GlossaryTerm[] {
  const parsed = Papa.parse<Record<string, string>>(text.replace(/^\uFEFF/, ''), { header: true, skipEmptyLines: true });
  return parsed.data.map(toTerm).filter((t): t is GlossaryTerm => t !== null);
}

/** Accepts a full glossary object (only `terms` is used) or a bare list of terms. */
export function termsFromJson(payload: unknown): GlossaryTerm[] {
  const raw = Array.isArray(payload)
    ? payload
    : typeof payload === 'object' && payload !== null && Array.isArray((payload as { terms?: unknown }).terms)
      ? (payload as { terms: unknown[] }).terms
      : [];
  return raw
    .filter((e): e is Record<string, unknown> => typeof e === 'object' && e !== null && !Array.isArray(e))
    .map(toTerm)
    .filter((t): t is GlossaryTerm => t !== null);
}

export class UnsupportedGlossaryFile extends Error {}

/** Parses an uploaded `.csv` or `.json` file. */
export function parseGlossaryFile(fileName: string, text: string): GlossaryTerm[] {
  const lower = fileName.toLowerCase();
  if (lower.endsWith('.json')) {
    let payload: unknown = {};
    if (text.trim()) {
      try {
        payload = JSON.parse(text.replace(/^\uFEFF/, ''));
      } catch (err) {
        throw new Error(`Invalid JSON file: ${(err as Error).message}`);
      }
    }
    return termsFromJson(payload);
  }
  if (lower.endsWith('.csv')) return termsFromCsv(text);
  throw new UnsupportedGlossaryFile('Unsupported file type (expected .json or .csv)');
}

/** Drops empty sources and repeated sources (first wins), counting what was dropped. */
export function dedupeTerms(terms: GlossaryTerm[]): { terms: GlossaryTerm[]; result: ReplaceResult } {
  const seen = new Set<string>();
  const kept: GlossaryTerm[] = [];
  let skippedEmpty = 0;
  let skippedDuplicate = 0;
  for (const term of terms) {
    const source = (term.source ?? '').trim();
    if (!source) { skippedEmpty++; continue; }
    if (seen.has(source)) { skippedDuplicate++; continue; }
    seen.add(source);
    kept.push({ ...term, source });
  }
  return { terms: kept, result: { inserted: kept.length, skippedEmpty, skippedDuplicate, totalInput: terms.length } };
}

export function termsToCsv(terms: GlossaryTerm[]): string {
  return Papa.unparse(
    { fields: ['source', 'target', 'category', 'gender'], data: terms.map((t) => [t.source, t.target, t.category ?? '', t.gender ?? '']) },
    { newline: '\n' },
  );
}

export function glossaryToJson(glossary: Pick<Glossary, 'name' | 'sourceLanguage' | 'targetLanguage' | 'terms'>): string {
  return JSON.stringify(
    {
      name: glossary.name,
      source_lang: glossary.sourceLanguage,
      target_lang: glossary.targetLanguage,
      terms: glossary.terms.map((t) => ({ source: t.source, target: t.target, category: t.category ?? '', gender: t.gender ?? '' })),
    },
    null,
    2,
  );
}
