import { Suspense } from 'react';
import { useTranslation } from 'react-i18next';
import { LOCALES } from './i18n';
import { ConnectionPanel } from './ui/ConnectionPanel';

export function App() {
  const { t, i18n } = useTranslation();
  return (
    <Suspense fallback={null}>
      <main className="mx-auto max-w-2xl space-y-6 p-6">
        <header className="flex items-center justify-between">
          <h1 className="text-xl font-semibold">LLM Book Translator</h1>
          <label className="flex items-center gap-2 text-sm">
            {t('language')}
            <select
              className="rounded border px-2 py-1"
              value={i18n.resolvedLanguage}
              onChange={(e) => void i18n.changeLanguage(e.target.value)}
            >
              {LOCALES.map((l) => <option key={l} value={l}>{l}</option>)}
            </select>
          </label>
        </header>
        <ConnectionPanel />
      </main>
    </Suspense>
  );
}
