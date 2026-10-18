// Port of src/core/style/extractor.py: turns a raw model answer into a validated, size-capped
// list of style rules, and runs the extraction prompt.

import { extractJsonPayload, pythonTypeName, stripThinkingBlocks, toStr, tryRepairJson } from '../json/balanced';
import type { LLMProvider } from '../llm/types';
import { generateStyleExtractionPrompt, STYLE_TAG_IN, STYLE_TAG_OUT, type StyleMode } from '../prompts/prompts';
import type { StyleRule } from './assembler';
import { ALLOWED_DIMENSIONS, DEFAULT_DIMENSION } from './dimensions';
import { lintInstruction } from './lint';

export const MAX_RULES = 40;
export const MAX_INSTRUCTION_CHARS = 500;
const MAX_EVIDENCE_CHARS = 200;
export const MAX_CONTEXT_CHARS = 600;

export interface ExtractedStyle {
  summary: string;
  suggestedName: string;
  context: string;
  rules: Required<StyleRule>[];
}

const emptyResult = (): ExtractedStyle => ({ summary: '', suggestedName: 'extracted_style', context: '', rules: [] });

const slugify = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 48) || 'extracted_style';

function truncateInstruction(instruction: string): string {
  let cut = instruction.slice(0, MAX_INSTRUCTION_CHARS);
  const lastSpace = cut.lastIndexOf(' ');
  if (lastSpace > 0) cut = cut.slice(0, lastSpace);
  return `${cut.trimEnd()}…`;
}

function normalizeRules(rawRules: unknown[]): { rules: Required<StyleRule>[]; warnings: string[] } {
  const warnings: string[] = [];
  let rules: Required<StyleRule>[] = [];
  const seen = new Set<string>();

  rawRules.forEach((entry, i) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return;
    const e = entry as Record<string, unknown>;
    const index = i + 1;

    let dimension = toStr(e.dimension).toLowerCase();
    if (!(ALLOWED_DIMENSIONS as readonly string[]).includes(dimension)) {
      warnings.push(`unknown dimension '${dimension || '(empty)'}' for rule ${index} (mapped to 'other')`);
      dimension = DEFAULT_DIMENSION;
    }

    let instruction = toStr(e.instruction);
    if (!instruction) { warnings.push("skipped rule without 'instruction'"); return; }
    if (instruction.length > MAX_INSTRUCTION_CHARS) {
      instruction = truncateInstruction(instruction);
      warnings.push(`truncated instruction for rule ${index} to ${MAX_INSTRUCTION_CHARS} characters`);
    }

    const key = instruction.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    rules.push({ dimension, instruction, evidence: toStr(e.evidence).slice(0, MAX_EVIDENCE_CHARS), flags: lintInstruction(instruction) });
  });

  if (rules.length > MAX_RULES) {
    warnings.push(`truncated rule list to ${MAX_RULES} rules`);
    rules = rules.slice(0, MAX_RULES);
  }
  return { rules, warnings };
}

/** Permissive parser (tagged, fenced or bare JSON). Never throws. */
export function parseStyleResponse(raw: string): { style: ExtractedStyle; warnings: string[] } {
  if (!raw) return { style: emptyResult(), warnings: ['empty LLM response'] };

  const text = stripThinkingBlocks(raw).trim();
  const warnings: string[] = [];
  const payload = extractJsonPayload(text, STYLE_TAG_IN, STYLE_TAG_OUT, 'STYLE_JSON', warnings);
  if (payload === null) return { style: emptyResult(), warnings: [...warnings, 'could not locate any JSON payload in response'] };

  let data: unknown;
  try {
    data = JSON.parse(payload);
  } catch (err) {
    const repaired = tryRepairJson(payload);
    if (repaired === null) return { style: emptyResult(), warnings: [...warnings, `json parse error: ${(err as Error).message}`] };
    try {
      data = JSON.parse(repaired);
      warnings.push('json was repaired before parsing (trailing comma or similar)');
    } catch (err2) {
      return { style: emptyResult(), warnings: [...warnings, `json parse error after repair: ${(err2 as Error).message}`] };
    }
  }

  let summary = '';
  let suggestedName = 'extracted_style';
  let context = '';
  let rawRules: unknown[];
  if (Array.isArray(data)) {
    warnings.push("response root is a bare JSON array — treated as 'rules' list");
    rawRules = data;
  } else if (typeof data === 'object' && data !== null) {
    const d = data as Record<string, unknown>;
    summary = toStr(d.summary);
    suggestedName = slugify(toStr(d.suggested_name));
    context = toStr(d.context);
    if (Array.isArray(d.rules)) {
      rawRules = d.rules;
    } else {
      warnings.push("response object has no usable 'rules' list");
      rawRules = [];
    }
  } else {
    return { style: emptyResult(), warnings: [...warnings, `unexpected JSON root type: ${pythonTypeName(data)}`] };
  }

  if (context.length > MAX_CONTEXT_CHARS) {
    context = context.slice(0, MAX_CONTEXT_CHARS).trimEnd();
    warnings.push(`truncated context to ${MAX_CONTEXT_CHARS} characters`);
  }
  const normalized = normalizeRules(rawRules);
  warnings.push(...normalized.warnings);
  return { style: { summary, suggestedName: suggestedName || 'extracted_style', context, rules: normalized.rules }, warnings };
}

export async function extractStyle(
  text: string,
  mode: StyleMode,
  sourceLanguage: string,
  targetLanguage: string,
  provider: LLMProvider,
  maxChars = 10000,
  signal?: AbortSignal,
): Promise<{ style: ExtractedStyle; warnings: string[] }> {
  const sample = maxChars && text.length > maxChars ? text.slice(0, maxChars) : text;
  const prompt = generateStyleExtractionPrompt(sample, mode, sourceLanguage, targetLanguage);
  const response = await provider.generate(prompt.user, { systemPrompt: prompt.system, signal });
  if (!response) return { style: emptyResult(), warnings: ['LLM returned no response'] };

  const result = parseStyleResponse(response.content);
  if (!result.style.rules.length && !result.warnings.includes('LLM returned no usable style rules')) {
    result.warnings.push('LLM returned no usable style rules');
  }
  return result;
}
