import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';

export const BASE_URL_PRESETS = [
  { id: 'openai', url: 'https://api.openai.com/v1' },
  { id: 'openrouter', url: 'https://openrouter.ai/api/v1' },
  { id: 'groq', url: 'https://api.groq.com/openai/v1' },
  { id: 'deepseek', url: 'https://api.deepseek.com/v1' },
  { id: 'mistral', url: 'https://api.mistral.ai/v1' },
  { id: 'gemini', url: 'https://generativelanguage.googleapis.com/v1beta/openai' },
] as const;

interface SettingsState {
  baseUrl: string;
  model: string;
  /** Comma- or newline-separated keys; rotated on HTTP 429. */
  apiKey: string;
  rememberKey: boolean;
  /** Models listed by the last successful connection test; not persisted. */
  models: string[];
  set: (patch: Partial<Omit<SettingsState, 'set'>>) => void;
}

const safeStorage = (kind: 'local' | 'session') => ({
  getItem: (k: string) => {
    try { return (kind === 'local' ? localStorage : sessionStorage).getItem(k); } catch { return null; }
  },
  setItem: (k: string, v: string) => {
    try { (kind === 'local' ? localStorage : sessionStorage).setItem(k, v); } catch { /* storage unavailable */ }
  },
  removeItem: (k: string) => {
    try { (kind === 'local' ? localStorage : sessionStorage).removeItem(k); } catch { /* storage unavailable */ }
  },
});

// Non-secret settings persist in localStorage; the key goes to sessionStorage
// unless the user opts in to remembering it on this device.
const prefs = safeStorage('local');
const session = safeStorage('session');
const KEY_STORE = 'tbl_api_key_v1';

export const useSettings = create<SettingsState>()(
  persist(
    (set) => ({
      baseUrl: BASE_URL_PRESETS[0].url,
      model: '',
      apiKey: '',
      rememberKey: false,
      models: [],
      set: (patch) => set(patch),
    }),
    {
      name: 'tbl_settings_v1',
      storage: createJSONStorage(() => prefs),
      partialize: (s) => ({
        baseUrl: s.baseUrl,
        model: s.model,
        rememberKey: s.rememberKey,
        ...(s.rememberKey ? { apiKey: s.apiKey } : {}),
      }),
      onRehydrateStorage: () => (state) => {
        if (state && !state.apiKey) {
          const k = session.getItem(KEY_STORE);
          if (k) state.set({ apiKey: k });
        }
      },
    },
  ),
);

useSettings.subscribe((s) => {
  if (s.rememberKey) session.removeItem(KEY_STORE);
  else if (s.apiKey) session.setItem(KEY_STORE, s.apiKey);
  else session.removeItem(KEY_STORE);
});
