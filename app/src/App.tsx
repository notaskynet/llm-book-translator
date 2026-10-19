import { Suspense, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Monitor, Moon, Sun } from 'lucide-react';
import { LOCALES, LOCALE_NAMES } from './i18n';
import { THEMES, useTheme, type Theme } from './theme';
import { ConnectionPanel } from './ui/ConnectionPanel';
import { GlossariesPanel } from './ui/GlossariesPanel';
import { SamplePanel } from './ui/SamplePanel';
import { StylesPanel } from './ui/StylesPanel';
import { TranslatePanel } from './ui/TranslatePanel';

const TABS = [
  { id: 'translate', ns: 'translate', label: 'title' },
  { id: 'styles', ns: 'style', label: 'title' },
  { id: 'glossaries', ns: 'glossary', label: 'title' },
  { id: 'sample', ns: 'sample', label: 'title' },
] as const;

const THEME_ICONS = { system: Monitor, light: Sun, dark: Moon } as const;

function ThemeToggle() {
  const { t } = useTranslation();
  const { theme, set } = useTheme();
  return (
    <div role="group" aria-label={t('theme')} className="flex rounded-md border bg-surface p-0.5">
      {THEMES.map((value: Theme) => {
        const Icon = THEME_ICONS[value];
        const label = t(`theme_${value}`);
        return (
          <button
            key={value}
            type="button"
            title={label}
            aria-label={label}
            aria-pressed={theme === value}
            className={`rounded p-1.5 ${theme === value ? 'bg-accent text-accent-fg' : 'text-gray-600'}`}
            onClick={() => set(value)}
          >
            <Icon size={16} aria-hidden />
          </button>
        );
      })}
    </div>
  );
}

export function App() {
  const { t, i18n } = useTranslation();
  const [tab, setTab] = useState<(typeof TABS)[number]['id']>('translate');
  return (
    <Suspense fallback={null}>
      <main className="mx-auto max-w-3xl space-y-6 px-4 py-8 sm:px-6">
        <header className="flex flex-wrap items-center justify-between gap-3">
          <h1 className="flex items-center gap-2 text-xl font-semibold">
            <img src={`${import.meta.env.BASE_URL}favicon.svg`} alt="" className="h-7 w-7" />
            LLM Book Translator
          </h1>
          <div className="flex items-center gap-3">
            <ThemeToggle />
            <select
              aria-label={t('language')}
              title={t('language')}
              className="rounded-md border px-2 py-1 text-sm"
              value={i18n.resolvedLanguage}
              onChange={(e) => void i18n.changeLanguage(e.target.value)}
            >
              {LOCALES.map((l) => <option key={l} value={l}>{LOCALE_NAMES[l]}</option>)}
            </select>
          </div>
        </header>
        <ConnectionPanel />
        <div role="tablist" aria-label={t('translate:tabs')} className="flex gap-2 border-b">
          {TABS.map((x) => (
            <button
              key={x.id}
              role="tab"
              aria-selected={tab === x.id}
              className={`-mb-px border-b-2 px-4 py-2 text-sm transition-colors ${tab === x.id ? 'border-accent font-medium' : 'border-transparent text-gray-600 hover:text-[var(--text)]'}`}
              onClick={() => setTab(x.id)}
            >
              {t(`${x.ns}:${x.label}`)}
            </button>
          ))}
        </div>
        {tab === 'translate' && <TranslatePanel />}
        {tab === 'styles' && <StylesPanel />}
        {tab === 'glossaries' && <GlossariesPanel />}
        {tab === 'sample' && <SamplePanel />}
      </main>
    </Suspense>
  );
}
