// Light / dark / system theme. The choice lives in localStorage; "system" follows the OS.
// The stylesheet reads it from `data-theme` on <html> (absent means "system").

import { create } from 'zustand';

export type Theme = 'light' | 'dark' | 'system';
export const THEMES: readonly Theme[] = ['system', 'light', 'dark'];
const KEY = 'tbl_theme';

function stored(): Theme {
  try {
    const value = localStorage.getItem(KEY);
    return value === 'light' || value === 'dark' ? value : 'system';
  } catch {
    return 'system';
  }
}

function apply(theme: Theme) {
  if (theme === 'system') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', theme);
}

export const useTheme = create<{ theme: Theme; set: (theme: Theme) => void }>((set) => ({
  theme: stored(),
  set: (theme) => {
    try { localStorage.setItem(KEY, theme); } catch { /* private mode: the choice lasts for this visit */ }
    apply(theme);
    set({ theme });
  },
}));

/** Call once at startup, before the first render, so the page never flashes the wrong theme. */
export const initTheme = () => apply(useTheme.getState().theme);
