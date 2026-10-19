import { describe, expect, it } from 'vitest';
import reference from './fixtures/python-reference.json';
import { buildChunkGlossaryBlock } from '../src/glossary/chunkBlock';
import { filterGlossary } from '../src/glossary/filter';
import { targetLanguageIsInflected } from '../src/glossary/inflection';
import { buildCastBlock, buildGlossaryBlock } from '../src/glossary/injector';
import { normalizeGender, type TermMetadata } from '../src/glossary/models';
import { parseNerResponse } from '../src/glossary/ner';
import { parsePreset, serializePreset } from '../src/presets/format';
import { generateNerExtractionPrompt, generateStyleExtractionPrompt, type StyleMode } from '../src/prompts/prompts';
import { assembleInstructions } from '../src/style/assembler';
import { parseStyleResponse } from '../src/style/extractor';
import { lintInstruction } from '../src/style/lint';
import { takeDistributedSamples } from '../src/documents/sampler';

const pairs = (list: unknown) => new Map(Array.isArray(list) ? (list as Array<[string, string]>) : Object.entries(list as Record<string, string>));
const meta = (m: unknown) => m as TermMetadata;

describe('prompts match the Python implementation', () => {
  for (const c of reference.ner_prompts) {
    it(`NER ${JSON.stringify(c.args)}`, () => {
      const [text, src, tgt] = c.args as string[];
      expect(generateNerExtractionPrompt(text, src, tgt)).toEqual({ system: c.system, user: c.user });
    });
  }
  for (const c of reference.style_prompts) {
    it(`style ${c.args[1]}`, () => {
      const [text, mode, src, tgt] = c.args as string[];
      expect(generateStyleExtractionPrompt(text, mode as StyleMode, src, tgt)).toEqual({ system: c.system, user: c.user });
    });
  }
  it('rejects an unknown style mode', () => {
    expect(() => generateStyleExtractionPrompt('x', 'other' as StyleMode)).toThrow();
  });
});

describe('glossary matches the Python implementation', () => {
  for (const c of reference.glossary_filter) {
    it(`filter ${JSON.stringify(c.chunk).slice(0, 30)} cs=${c.case_sensitive} max=${c.max_entries}`, () => {
      const out = filterGlossary(c.chunk, pairs(c.terms), {
        maxEntries: c.max_entries, caseSensitive: c.case_sensitive, warnOnCap: true, maxCastEntries: 80,
      });
      expect([...out.terms]).toEqual(c.result);
      expect(out.capped).toBe(c.capped);
    });
  }

  for (const c of reference.glossary_blocks) {
    it(`glossary block (${c.target_language || 'no language'})`, () => {
      expect(buildGlossaryBlock(pairs(c.terms), c.target_language, meta(c.metadata))).toBe(c.block);
      expect(targetLanguageIsInflected(c.target_language)).toBe(c.inflected);
    });
  }

  for (const c of reference.glossary_cast) {
    it(`cast block max=${c.max_entries}`, () => {
      expect(buildCastBlock(pairs(c.terms), meta(c.metadata), c.max_entries)).toEqual({ block: c.block, capped: c.capped });
    });
  }

  for (const c of reference.glossary_chunk_blocks) {
    it(`chunk block ${JSON.stringify(c.chunk).slice(0, 25)} max=${c.max_entries}`, () => {
      const terms = pairs(reference.glossary_filter[0].terms);
      const glossary = c.no_glossary ? undefined : { terms, metadata: meta(reference.glossary_blocks[0].metadata), config: { maxEntries: c.max_entries } };
      expect(buildChunkGlossaryBlock(c.chunk, glossary, { targetLanguage: c.target_language })).toBe(c.block);
    });
  }

  for (const c of reference.gender) {
    it(`normalizeGender(${JSON.stringify(c.input)})`, () => expect(normalizeGender(c.input)).toBe(c.result));
  }

  it('warns about a capped glossary once per job', () => {
    const logs: string[] = [];
    const state = {};
    const glossary = { terms: pairs([['a', 'A'], ['b', 'B'], ['c', 'C']]), config: { maxEntries: 1 } };
    for (let i = 0; i < 3; i++) buildChunkGlossaryBlock('a b c', glossary, { log: (e) => logs.push(e), state });
    expect(logs).toEqual(['glossary_capped']);
  });
});

describe('NER parsing matches the Python implementation', () => {
  for (const c of reference.ner_parse) {
    it(JSON.stringify(c.raw).slice(0, 50), () => {
      const out = parseNerResponse(c.raw);
      expect(out.candidates).toEqual(c.candidates);
      expect(out.warnings).toEqual(c.warnings);
    });
  }
});

describe('style extraction matches the Python implementation', () => {
  for (const c of reference.style_parse) {
    it(`parse ${JSON.stringify(c.raw).slice(0, 40)}`, () => {
      const out = parseStyleResponse(c.raw);
      expect(out.style.summary).toBe(c.style.summary);
      expect(out.style.suggestedName).toBe(c.style.suggested_name);
      expect(out.style.context).toBe(c.style.context);
      expect(out.style.rules).toEqual(c.style.rules);
      expect(out.warnings).toEqual(c.warnings);
    });
  }
  for (const c of reference.style_lint) {
    it(`lint ${JSON.stringify(c.text).slice(0, 45)}`, () => expect(lintInstruction(c.text)).toEqual(c.flags));
  }
  for (const c of reference.style_assemble) {
    it(`assemble ${c.mode} ${c.context ? 'with' : 'without'} setting (${c.rules.length} rules)`, () => {
      expect(assembleInstructions(c.mode as StyleMode, c.rules, c.context)).toEqual(c.result);
    });
  }
  it('the assembled preambles lint clean themselves', () => {
    const assembled = assembleInstructions('source', [{ dimension: 'register', instruction: 'Keep a dry, detached tone' }]);
    for (const line of assembled.translation!.split('\n').filter((l) => l.startsWith('Match') || l.startsWith('Treat'))) {
      expect(lintInstruction(line), line).not.toContain('quoted_example');
    }
  });
});

describe('document sampling matches the Python implementation', () => {
  const text = Array.from({ length: 4000 }, (_, i) => `word${i}`).join(' ');
  for (const c of reference.samples) {
    it(`budget ${c.total} samples ${c.n} min ${c.min}`, () => {
      expect(takeDistributedSamples(text, c.total, c.n, c.min)).toEqual(c.result);
    });
  }
});

describe('presets', () => {
  for (const c of reference.presets) {
    it(`reads the Python file ${c.filename}`, () => {
      const parsed = parsePreset(c.filename, c.yaml);
      const py = c.preset;
      expect(parsed).toMatchObject({
        name: py.display_name, description: py.description, mode: py.mode, context: py.context,
        sourceFiles: py.source_files, generatedAt: py.generated_at, rules: py.rules,
        translation: py.translation, refinement: py.refinement,
      });
    });
  }

  it('writes YAML the Python side reads back identically', () => {
    const full = reference.presets[0];
    const parsed = parsePreset(full.filename, full.yaml);
    const { id: _id, name: _name, ...rest } = parsed;
    const written = serializePreset({ ...rest });
    expect(written).toBe(full.yaml);
    expect(parsePreset('x.yaml', written)).toEqual({ ...parsed, id: 'x', name: 'x' });
  });

  it('rejects a YAML file that is not a mapping', () => {
    expect(() => parsePreset('bad.yaml', '- just\n- a list')).toThrow(/mapping/);
  });
});
