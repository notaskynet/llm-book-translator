// Port of src/core/glossary/ner.py: NER-assisted glossary extraction. The model proposes
// recurring named entities; the user reviews them, nothing is applied automatically.

import { extractJsonPayload, pythonTypeName, stripThinkingBlocks, toStr, tryRepairJson } from '../json/balanced';
import type { LLMProvider } from '../llm/types';
import { generateNerExtractionPrompt } from '../prompts/prompts';
import { normalizeGender } from './models';

export const NER_TAG_IN = '<NER_JSON>';
export const NER_TAG_OUT = '</NER_JSON>';
const ALLOWED_CATEGORIES = new Set(['character', 'location', 'organization', 'item', 'title', 'other']);

export interface NerCandidate {
  source: string;
  target: string;
  category: string;
  gender: string;
}

function coerceToListOfObjects(data: unknown, warnings: string[]): Array<Record<string, unknown>> {
  const isObject = (d: unknown): d is Record<string, unknown> => typeof d === 'object' && d !== null && !Array.isArray(d);
  if (Array.isArray(data)) return data.filter(isObject);
  if (isObject(data)) {
    for (const key of ['entities', 'terms', 'candidates', 'items', 'results']) {
      if (Array.isArray(data[key])) {
        warnings.push(`unwrapped list from '${key}' field`);
        return (data[key] as unknown[]).filter(isObject);
      }
    }
    if ('source' in data) return [data];
    warnings.push('response was an object without a recognized list field');
    return [];
  }
  warnings.push(`unexpected JSON root type: ${pythonTypeName(data)}`);
  return [];
}

/** Permissive parser: tagged, fenced or bare JSON, with trailing-comma repair. Never throws. */
export function parseNerResponse(raw: string): { candidates: NerCandidate[]; warnings: string[] } {
  if (!raw) return { candidates: [], warnings: ['empty LLM response'] };

  const text = stripThinkingBlocks(raw).trim();
  const warnings: string[] = [];
  const payload = extractJsonPayload(text, NER_TAG_IN, NER_TAG_OUT, 'NER', warnings);
  if (payload === null) return { candidates: [], warnings: [...warnings, 'could not locate any JSON payload in response'] };

  let data: unknown;
  try {
    data = JSON.parse(payload);
  } catch (err) {
    const repaired = tryRepairJson(payload);
    if (repaired === null) return { candidates: [], warnings: [...warnings, `JSON parse error: ${(err as Error).message}`] };
    try {
      data = JSON.parse(repaired);
      warnings.push('JSON was repaired before parsing (trailing comma or similar)');
    } catch (err2) {
      return { candidates: [], warnings: [...warnings, `JSON parse error after repair: ${(err2 as Error).message}`] };
    }
  }

  const candidates: NerCandidate[] = [];
  const seen = new Set<string>();
  for (const entry of coerceToListOfObjects(data, warnings)) {
    const source = toStr(entry.source || entry.source_term);
    const target = toStr(entry.target || entry.translated_term || entry.translation);
    const category = toStr(entry.category || entry.type || '').toLowerCase();
    const gender = normalizeGender(entry.gender || entry.sex);

    if (!source) { warnings.push("skipped entry without 'source'"); continue; }
    if (seen.has(source)) continue;
    seen.add(source);
    if (category && !ALLOWED_CATEGORIES.has(category)) warnings.push(`unknown category '${category}' for '${source}' (kept as-is)`);
    candidates.push({ source, target, category: category || 'other', gender: gender ?? '' });
  }
  return { candidates, warnings };
}

export async function suggestTerms(
  text: string,
  sourceLanguage: string,
  targetLanguage: string,
  provider: LLMProvider,
  maxChars = 6000,
  signal?: AbortSignal,
): Promise<{ candidates: NerCandidate[]; warnings: string[] }> {
  const sample = maxChars && text.length > maxChars ? text.slice(0, maxChars) : text;
  const prompt = generateNerExtractionPrompt(sample, sourceLanguage, targetLanguage);
  const response = await provider.generate(prompt.user, { systemPrompt: prompt.system, signal });
  if (!response) return { candidates: [], warnings: ['LLM returned no response'] };

  const result = parseNerResponse(response.content);
  if (!result.candidates.length && !result.warnings.length) {
    result.warnings.push('LLM returned a valid empty list — no recurring entities detected');
  }
  return result;
}
