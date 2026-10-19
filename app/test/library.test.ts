import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { BookTranslatorDB } from '../src/checkpoint/db';
import {
  dedupeTerms, glossaryToJson, parseGlossaryFile, termsFromCsv, termsFromJson, termsToCsv, UnsupportedGlossaryFile,
} from '../src/glossary/io';
import { LibraryStore, NameConflictError } from '../src/library/store';
import { serializePreset } from '../src/presets/format';

let n = 0;
let library: LibraryStore;
beforeEach(() => {
  library = new LibraryStore(new BookTranslatorDB(`library-${n++}`));
});

describe('glossary import and export', () => {
  const csv = 'source,target,category,gender\nLi Fan,李凡,character,M\n,orphan,,\nMoscow,Москва,location,\nLi Fan,dup,,\n';

  it('reads CSV with the Python column names, skipping rows without a source', () => {
    const terms = termsFromCsv(csv);
    expect(terms.map((t) => t.source)).toEqual(['Li Fan', 'Moscow', 'Li Fan']);
    expect(terms[0]).toEqual({ source: 'Li Fan', target: '李凡', category: 'character', gender: 'male' });
  });

  it('reads the alternative column names and a BOM', () => {
    const terms = termsFromCsv('\uFEFFsource_term,translated_term,sex\nA,B,woman\n');
    expect(terms).toEqual([{ source: 'A', target: 'B', category: null, gender: 'female' }]);
  });

  it('reads JSON as a full glossary or a bare list', () => {
    expect(termsFromJson({ terms: [{ source: 'a', target: 'b' }, 'junk', { target: 'x' }] })).toHaveLength(1);
    expect(termsFromJson([{ source_term: 'a', translated_term: 'b', gender: 'f' }])[0].gender).toBe('female');
    expect(termsFromJson('nope')).toEqual([]);
  });

  it('dispatches on the file extension', () => {
    expect(parseGlossaryFile('g.CSV', csv)).toHaveLength(3);
    expect(parseGlossaryFile('g.json', '')).toEqual([]);
    expect(() => parseGlossaryFile('g.json', '{bad')).toThrow(/Invalid JSON/);
    expect(() => parseGlossaryFile('g.xlsx', '')).toThrow(UnsupportedGlossaryFile);
  });

  it('counts what a replace drops', () => {
    const { terms, result } = dedupeTerms([...termsFromCsv(csv), { source: '  ', target: 'x' }]);
    expect(terms.map((t) => t.source)).toEqual(['Li Fan', 'Moscow']);
    expect(result).toEqual({ inserted: 2, skippedEmpty: 1, skippedDuplicate: 1, totalInput: 4 });
  });

  it('round-trips through CSV and JSON', () => {
    const terms = [{ source: 'Li, Fan', target: 'a "quoted" b', category: 'character', gender: 'male' as const }];
    expect(termsFromCsv(termsToCsv(terms))).toEqual(terms);
    const json = glossaryToJson({ name: 'g', sourceLanguage: 'Chinese', targetLanguage: 'English', terms });
    expect(termsFromJson(JSON.parse(json))).toEqual(terms);
    expect(JSON.parse(json)).toMatchObject({ name: 'g', source_lang: 'Chinese', target_lang: 'English' });
  });
});

describe('LibraryStore glossaries', () => {
  it('creates, lists and enforces unique names', async () => {
    const g = await library.createGlossary({ name: ' Saga ', sourceLanguage: 'Chinese', targetLanguage: 'English', terms: [{ source: 'a', target: 'A' }, { source: 'a', target: 'dup' }] });
    expect(g.name).toBe('Saga');
    expect(g.terms).toHaveLength(1);
    await expect(library.createGlossary({ name: 'Saga' })).rejects.toBeInstanceOf(NameConflictError);
    expect((await library.listGlossaries()).map((x) => x.name)).toEqual(['Saga']);
  });

  it('renames, but not onto an existing name', async () => {
    const a = await library.createGlossary({ name: 'A' });
    await library.createGlossary({ name: 'B' });
    await expect(library.updateGlossary(a.id!, { name: 'B' })).rejects.toBeInstanceOf(NameConflictError);
    await library.updateGlossary(a.id!, { name: 'A', targetLanguage: 'French' }); // keeping its own name is fine
    expect((await library.getGlossary(a.id!))!.targetLanguage).toBe('French');
  });

  it('adds terms without overwriting existing sources', async () => {
    const g = await library.createGlossary({ name: 'G', terms: [{ source: 'a', target: 'A' }] });
    const out = await library.addTerms(g.id!, [{ source: 'a', target: 'other' }, { source: 'b', target: 'B' }, { source: ' ', target: 'x' }]);
    expect(out).toEqual({ added: 1, conflicts: 1, skippedEmpty: 1 });
    expect((await library.getGlossary(g.id!))!.terms).toEqual([{ source: 'a', target: 'A' }, { source: 'b', target: 'B' }]);
  });

  it('replaces all terms and reports the drops', async () => {
    const g = await library.createGlossary({ name: 'G', terms: [{ source: 'old', target: 'O' }] });
    const result = await library.replaceTerms(g.id!, [{ source: 'a', target: 'A' }, { source: 'a', target: 'B' }, { source: '', target: 'C' }]);
    expect(result).toMatchObject({ inserted: 1, skippedDuplicate: 1, skippedEmpty: 1 });
    expect((await library.getGlossary(g.id!))!.terms.map((t) => t.source)).toEqual(['a']);
  });

  it('duplicates and deletes', async () => {
    const g = await library.createGlossary({ name: 'G', terms: [{ source: 'a', target: 'A' }] });
    const copy = await library.duplicateGlossary(g.id!, 'G copy');
    expect(copy.terms).toEqual(g.terms);
    await library.deleteGlossary(g.id!);
    expect((await library.listGlossaries()).map((x) => x.name)).toEqual(['G copy']);
  });
});

describe('LibraryStore presets', () => {
  const preset = { name: 'Dry noir', description: 'd', mode: 'source' as const, context: '', sourceFiles: [], generatedAt: null, rules: [], translation: 'Be dry.', refinement: null };

  it('saves under a slug id and overwrites by name', async () => {
    const saved = await library.savePreset(preset);
    expect(saved.id).toBe('Dry_noir');
    await library.savePreset({ ...preset, translation: 'Be drier.' });
    const all = await library.listPresets();
    expect(all).toHaveLength(1);
    expect(all[0].translation).toBe('Be drier.');
  });

  it('imports a preset file, from YAML and from a legacy .txt', async () => {
    const yaml = serializePreset({ ...preset, mode: 'model' });
    expect((await library.importPresetFile('noir.yaml', yaml)).mode).toBe('model');
    const legacy = await library.importPresetFile('formal.txt', 'Be formal.\n');
    expect(legacy).toMatchObject({ translation: 'Be formal.', refinement: 'Be formal.' });
    expect((await library.listPresets()).map((p) => p.id)).toEqual(['formal', 'noir']);
  });

  it('deletes', async () => {
    const saved = await library.savePreset(preset);
    await library.deletePreset(saved.id);
    expect(await library.listPresets()).toEqual([]);
  });
});
