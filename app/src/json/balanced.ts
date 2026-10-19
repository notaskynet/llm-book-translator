// Helpers shared by the NER and style-extraction parsers (src/core/glossary/ner.py).

/** Removes the reasoning blocks some models emit before their answer. */
export function stripThinkingBlocks(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/gi, '');
}

/** The first balanced `opener ... closer` run, ignoring brackets inside JSON strings. */
export function findBalanced(text: string, opener: string, closer: string): string | null {
  const start = text.indexOf(opener);
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (escape) { escape = false; continue; }
    if (ch === '\\') { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === opener) depth++;
    else if (ch === closer && --depth === 0) return text.slice(start, i + 1);
  }
  return null;
}

/** Best-effort repair: drops trailing commas before `}` or `]`. Null when nothing changed. */
export function tryRepairJson(payload: string): string | null {
  const repaired = payload.replace(/,\s*([}\]])/g, '$1');
  return repaired !== payload ? repaired : null;
}

/** The JSON payload of a model answer: tagged, fenced, or the first balanced container. */
export function extractJsonPayload(text: string, tagIn: string, tagOut: string, label: string, warnings: string[]): string | null {
  const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const tagged = new RegExp(`${escape(tagIn)}\\s*([\\s\\S]*?)\\s*${escape(tagOut)}`).exec(text);
  if (tagged) return tagged[1].trim();

  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  if (fenced) {
    warnings.push(`${label} tags missing — extracted from markdown code fence`);
    return fenced[1].trim();
  }

  // Whichever container appears first wins: a bare array of objects starts with '[' before
  // its first '{', and an object wrapping the array starts with '{'.
  const objPos = text.indexOf('{');
  const arrPos = text.indexOf('[');
  if (objPos !== -1 && (arrPos === -1 || objPos < arrPos)) {
    const obj = findBalanced(text, '{', '}');
    if (obj) { warnings.push(`${label} tags missing — extracted balanced JSON object`); return obj; }
  }
  if (arrPos !== -1) {
    const arr = findBalanced(text, '[', ']');
    if (arr) { warnings.push(`${label} tags missing — extracted balanced JSON array`); return arr; }
  }
  if (objPos !== -1) {
    const obj = findBalanced(text, '{', '}');
    if (obj) { warnings.push(`${label} tags missing — extracted balanced JSON object`); return obj; }
  }
  return null;
}

/** Python's type name for a parsed JSON value, so warning texts match the original. */
export function pythonTypeName(value: unknown): string {
  if (value === null) return 'NoneType';
  if (Array.isArray(value)) return 'list';
  switch (typeof value) {
    case 'string': return 'str';
    case 'number': return Number.isInteger(value) ? 'int' : 'float';
    case 'boolean': return 'bool';
    default: return 'dict';
  }
}

export const toStr = (value: unknown): string => (value == null ? '' : String(value).trim());
