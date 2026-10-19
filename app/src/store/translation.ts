import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { DEFAULT_MAX_TOKENS_PER_CHUNK } from '../config';

export interface TranslationOptions {
  sourceLanguage: string;
  targetLanguage: string;
  bilingual: boolean;
  maxTokensPerChunk: number;
  parallelWorkers: number;
  /** Style preset (id) applied to the translation, or null. */
  presetId: string | null;
  /** Glossary (id) whose terms are injected into the prompts, or null. */
  glossaryId: number | null;
  /** Ask the model to repair OCR errors and broken line breaks while translating. */
  textCleanup: boolean;
  /** 'refine' polishes a file that is already translated instead of translating it. */
  task: 'translate' | 'refine';
  /** After translating, run a polish pass on the result. */
  refineAfter: boolean;
}

interface OptionsState extends TranslationOptions {
  set: (patch: Partial<TranslationOptions>) => void;
}

/** The option values only, without the store's actions (which cannot be persisted or cloned). */
export function currentOptions(): TranslationOptions {
  const { sourceLanguage, targetLanguage, bilingual, maxTokensPerChunk, parallelWorkers, presetId, glossaryId, textCleanup, task, refineAfter } =
    useTranslationOptions.getState();
  return { sourceLanguage, targetLanguage, bilingual, maxTokensPerChunk, parallelWorkers, presetId, glossaryId, textCleanup, task, refineAfter };
}

export const useTranslationOptions = create<OptionsState>()(
  persist(
    (set) => ({
      sourceLanguage: 'English',
      targetLanguage: 'French',
      bilingual: false,
      maxTokensPerChunk: DEFAULT_MAX_TOKENS_PER_CHUNK,
      parallelWorkers: 3,
      presetId: null,
      glossaryId: null,
      textCleanup: false,
      task: 'translate',
      refineAfter: false,
      set: (patch) => set(patch),
    }),
    {
      name: 'tbl_translation_options_v1',
      storage: createJSONStorage(() => ({
        getItem: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
        setItem: (k, v) => { try { localStorage.setItem(k, v); } catch { /* storage unavailable */ } },
        removeItem: (k) => { try { localStorage.removeItem(k); } catch { /* storage unavailable */ } },
      })),
      partialize: ({ set: _set, ...options }) => options,
    },
  ),
);
