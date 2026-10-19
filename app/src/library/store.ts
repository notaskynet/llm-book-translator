// The user's style presets and glossaries, kept in IndexedDB next to the translation jobs.

import type { BookTranslatorDB } from '../checkpoint/db';
import { dedupeTerms, type ReplaceResult } from '../glossary/io';
import type { Glossary, GlossaryTerm } from '../glossary/models';
import { parsePreset, slugifyPresetName, type Preset } from '../presets/format';

export class NameConflictError extends Error {
  constructor(name: string) {
    super(`A glossary named "${name}" already exists`);
    this.name = 'NameConflictError';
  }
}

export type PresetInput = Omit<Preset, 'id' | 'updatedAt'> & { id?: string };

export class LibraryStore {
  constructor(private readonly db: BookTranslatorDB) {}

  // --- style presets -----------------------------------------------------------------

  async listPresets(): Promise<Preset[]> {
    return (await this.db.presets.toArray()).sort((a, b) => a.name.localeCompare(b.name));
  }

  getPreset(id: string) {
    return this.db.presets.get(id);
  }

  /** Creates or overwrites the preset with this name (its id is the name's slug). */
  async savePreset(input: PresetInput): Promise<Preset> {
    const preset: Preset = { ...input, id: input.id ?? slugifyPresetName(input.name), updatedAt: Date.now() };
    await this.db.presets.put(preset);
    return preset;
  }

  async importPresetFile(fileName: string, content: string): Promise<Preset> {
    return this.savePreset(parsePreset(fileName, content));
  }

  deletePreset(id: string) {
    return this.db.presets.delete(id);
  }

  // --- glossaries --------------------------------------------------------------------

  async listGlossaries(): Promise<Glossary[]> {
    return (await this.db.glossaries.toArray()).sort((a, b) => a.name.localeCompare(b.name));
  }

  getGlossary(id: number) {
    return this.db.glossaries.get(id);
  }

  private async assertNameFree(name: string, exceptId?: number) {
    const clash = await this.db.glossaries.where('name').equals(name).first();
    if (clash && clash.id !== exceptId) throw new NameConflictError(name);
  }

  async createGlossary(input: { name: string; sourceLanguage?: string; targetLanguage?: string; terms?: GlossaryTerm[] }): Promise<Glossary> {
    const name = input.name.trim();
    await this.assertNameFree(name);
    const { terms } = dedupeTerms(input.terms ?? []);
    const glossary: Glossary = {
      name, sourceLanguage: input.sourceLanguage ?? '', targetLanguage: input.targetLanguage ?? '', terms, updatedAt: Date.now(),
    };
    const id = (await this.db.glossaries.add(glossary)) as number;
    return { ...glossary, id };
  }

  async updateGlossary(id: number, patch: Partial<Pick<Glossary, 'name' | 'sourceLanguage' | 'targetLanguage'>>): Promise<void> {
    if (patch.name !== undefined) {
      const name = patch.name.trim();
      patch = { ...patch, name };
      await this.assertNameFree(name, id);
    }
    await this.db.glossaries.update(id, { ...patch, updatedAt: Date.now() });
  }

  deleteGlossary(id: number) {
    return this.db.glossaries.delete(id);
  }

  async duplicateGlossary(id: number, name: string): Promise<Glossary> {
    const source = await this.getGlossary(id);
    if (!source) throw new Error(`Glossary ${id} not found`);
    return this.createGlossary({ ...source, name });
  }

  /** Replaces all terms (import). Empty and repeated sources are dropped and counted. */
  async replaceTerms(id: number, terms: GlossaryTerm[]): Promise<ReplaceResult> {
    const { terms: kept, result } = dedupeTerms(terms);
    const updated = await this.db.glossaries.update(id, { terms: kept, updatedAt: Date.now() });
    if (!updated) return { inserted: 0, skippedEmpty: 0, skippedDuplicate: 0, totalInput: terms.length };
    return result;
  }

  /** Adds terms whose source is new; existing sources are counted as conflicts, not overwritten. */
  async addTerms(id: number, terms: GlossaryTerm[]): Promise<{ added: number; conflicts: number; skippedEmpty: number }> {
    return this.db.transaction('rw', this.db.glossaries, async () => {
      const glossary = await this.db.glossaries.get(id);
      if (!glossary) throw new Error(`Glossary ${id} not found`);
      const existing = new Set(glossary.terms.map((t) => t.source));
      const next = [...glossary.terms];
      let added = 0;
      let conflicts = 0;
      let skippedEmpty = 0;
      for (const term of terms) {
        const source = (term.source ?? '').trim();
        if (!source) { skippedEmpty++; continue; }
        if (existing.has(source)) { conflicts++; continue; }
        existing.add(source);
        next.push({ ...term, source });
        added++;
      }
      if (added) await this.db.glossaries.update(id, { terms: next, updatedAt: Date.now() });
      return { added, conflicts, skippedEmpty };
    });
  }

  /** Saves edited terms from the editor: empty sources are dropped, repeated ones rejected. */
  async setTerms(id: number, terms: GlossaryTerm[]): Promise<ReplaceResult> {
    return this.replaceTerms(id, terms);
  }
}
