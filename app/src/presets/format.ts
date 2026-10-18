// The preset file format of src/utils/custom_instructions.py: a YAML mapping with optional
// metadata (description, mode, context, source_files, generated_at, rules) and the two
// prompt blocks (translation, refinement). A legacy `.txt` applies one text to both phases.

import { parse, stringify, Scalar } from 'yaml';
import type { StyleRule } from '../style/assembler';
import type { StyleMode } from '../prompts/prompts';

// Key order used when a preset is written.
export const PRESET_KEY_ORDER = ['description', 'mode', 'context', 'source_files', 'generated_at', 'rules', 'translation', 'refinement'] as const;

export const SAFE_FILENAME = /^[A-Za-z0-9_\-.]+\.(?:txt|ya?ml)$/;

export interface Preset {
  /** Stable id, derived from the name. */
  id: string;
  name: string;
  description: string;
  mode: StyleMode | null;
  context: string;
  sourceFiles: string[];
  generatedAt: string | null;
  rules: StyleRule[];
  translation: string | null;
  refinement: string | null;
  updatedAt: number;
}

/** "Mon style — noir!" -> "Mon_style_noir". Case is kept; runs of other characters collapse. */
export function slugifyPresetName(name: string): string {
  const slug = (name ?? '').replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 64);
  if (!slug) throw new Error('Preset name cannot be empty');
  return slug;
}

const phaseValue = (value: unknown): string | null => {
  if (value == null) return null;
  return String(value).trim() || null;
};
const strField = (value: unknown): string | null => (value == null ? null : String(value));

function normalizeRules(rules: unknown): StyleRule[] {
  if (!Array.isArray(rules)) return [];
  return rules
    .filter((r): r is Record<string, unknown> => typeof r === 'object' && r !== null && !Array.isArray(r))
    .map((r) => ({ dimension: String(r.dimension ?? ''), instruction: String(r.instruction ?? '') }));
}

/** Reads a preset file's content. Throws on a YAML file that is not a mapping. */
export function parsePreset(filename: string, content: string): Omit<Preset, 'updatedAt'> {
  const text = content.replace(/^\uFEFF/, '');
  const name = filename.replace(/\.(txt|ya?ml)$/i, '');
  const base = {
    id: slugifyPresetName(name), name, description: '', mode: null as StyleMode | null, context: '',
    sourceFiles: [] as string[], generatedAt: null as string | null, rules: [] as StyleRule[],
    translation: null as string | null, refinement: null as string | null,
  };

  if (/\.txt$/i.test(filename)) {
    const stripped = text.trim() || null;
    return { ...base, translation: stripped, refinement: stripped };
  }

  const parsed = parse(text) as unknown;
  if (parsed == null) return base;
  if (typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Custom instructions YAML '${filename}' must be a mapping with optional 'translation' and 'refinement' keys.`);
  }
  const p = parsed as Record<string, unknown>;
  return {
    ...base,
    description: strField(p.description) ?? '',
    mode: (strField(p.mode) as StyleMode | null) ?? null,
    context: strField(p.context) ?? '',
    sourceFiles: Array.isArray(p.source_files) ? [...p.source_files] : [],
    generatedAt: strField(p.generated_at),
    rules: normalizeRules(p.rules),
    translation: phaseValue(p.translation),
    refinement: phaseValue(p.refinement),
  };
}

/** Serialises a preset. Long prose fields are written as YAML block literals, like the Python side. */
export function serializePreset(preset: Omit<Preset, 'id' | 'updatedAt' | 'name'>): string {
  const literal = (value: string) => {
    const scalar = new Scalar(value);
    scalar.type = Scalar.BLOCK_LITERAL;
    return scalar;
  };
  // Quoted, so a YAML reader does not turn the timestamp into a date object.
  const quoted = (value: string | null) => {
    if (value == null) return null;
    const scalar = new Scalar(value);
    scalar.type = Scalar.QUOTE_SINGLE;
    return scalar;
  };
  const doc: Record<string, unknown> = {};
  const values: Record<(typeof PRESET_KEY_ORDER)[number], unknown> = {
    description: preset.description,
    mode: preset.mode,
    context: literal(preset.context),
    source_files: preset.sourceFiles,
    generated_at: quoted(preset.generatedAt),
    rules: preset.rules.map((r) => ({ dimension: r.dimension, instruction: r.instruction })),
    translation: preset.translation == null ? null : literal(preset.translation),
    refinement: preset.refinement == null ? null : literal(preset.refinement),
  };
  for (const key of PRESET_KEY_ORDER) doc[key] = values[key];
  return stringify(doc, { lineWidth: 0, indentSeq: false });
}
