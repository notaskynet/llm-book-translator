import { Suspense, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { LOCALES } from './i18n';
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

export function App() {
  const { t, i18n } = useTranslation();
  const [tab, setTab] = useState<(typeof TABS)[number]['id']>('translate');
  return (
    <Suspense fallback={null}>
      <main className="mx-auto max-w-2xl space-y-6 p-6">
        <header className="flex items-center justify-between">
          <h1 className="text-xl font-semibold">LLM Book Translator</h1>
          <label className="flex items-center gap-2 text-sm">
            {t('language')}
            <select
              aria-label={t('language')}
              className="rounded border px-2 py-1"
              value={i18n.resolvedLanguage}
              onChange={(e) => void i18n.changeLanguage(e.target.value)}
            >
              {LOCALES.map((l) => <option key={l} value={l}>{l}</option>)}
            </select>
          </label>
        </header>
        <ConnectionPanel />
        <div role="tablist" aria-label={t('translate:tabs')} className="flex gap-2 border-b">
          {TABS.map((x) => (
            <button
              key={x.id}
              role="tab"
              aria-selected={tab === x.id}
              className={`-mb-px border-b-2 px-3 py-2 text-sm ${tab === x.id ? 'border-black font-medium' : 'border-transparent text-gray-600'}`}
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
