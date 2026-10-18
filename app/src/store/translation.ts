import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { DEFAULT_MAX_TOKENS_PER_CHUNK } from '../config';

export interface TranslationOptions {
  sourceLanguage: string;
  targetLanguage: string;
  bilingual: boolean;
  maxTokensPerChunk: number;
  parallelWorkers: number;
}

interface OptionsState extends TranslationOptions {
  set: (patch: Partial<TranslationOptions>) => void;
}

/** The option values only, without the store's actions (which cannot be persisted or cloned). */
export function currentOptions(): TranslationOptions {
  const { sourceLanguage, targetLanguage, bilingual, maxTokensPerChunk, parallelWorkers } = useTranslationOptions.getState();
  return { sourceLanguage, targetLanguage, bilingual, maxTokensPerChunk, parallelWorkers };
}

export const useTranslationOptions = create<OptionsState>()(
  persist(
    (set) => ({
      sourceLanguage: 'English',
      targetLanguage: 'French',
      bilingual: false,
      maxTokensPerChunk: DEFAULT_MAX_TOKENS_PER_CHUNK,
      parallelWorkers: 3,
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
