import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { BASE_URL_PRESETS, useSettings } from '@/store/settings';
import { classifyError, listModels } from '@/llm/client';

type Status = { kind: 'idle' } | { kind: 'ok'; count: number } | { kind: 'error'; message: string };

export function ConnectionPanel() {
  const { t } = useTranslation('connection');
  const { baseUrl, apiKey, model, rememberKey, set } = useSettings();
  const [models, setModels] = useState<string[]>([]);
  const [status, setStatus] = useState<Status>({ kind: 'idle' });
  const [busy, setBusy] = useState(false);

  const preset = BASE_URL_PRESETS.find((p) => p.url === baseUrl)?.id ?? 'custom';

  async function load() {
    setBusy(true);
    try {
      const ids = await listModels(baseUrl, apiKey);
      setModels(ids);
      set({ models: ids });
      setStatus({ kind: 'ok', count: ids.length });
    } catch (err) {
      const kind = classifyError(err);
      setStatus({ kind: 'error', message: kind === 'unauthorized' ? 'unauthorized' : kind === 'network' ? 'network' : 'failed' });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="space-y-4 rounded-lg border p-4">
      <h2 className="font-medium">{t('title')}</h2>

      <label className="block text-sm">
        {t('preset')}
        <select
          className="mt-1 block w-full rounded border px-2 py-1"
          value={preset}
          onChange={(e) => {
            const p = BASE_URL_PRESETS.find((x) => x.id === e.target.value);
            if (p) set({ baseUrl: p.url });
          }}
        >
          {BASE_URL_PRESETS.map((p) => <option key={p.id} value={p.id}>{p.id}</option>)}
          <option value="custom">{t('custom')}</option>
        </select>
      </label>

      <label className="block text-sm">
        {t('baseUrl')}
        <input
          className="mt-1 block w-full rounded border px-2 py-1"
          value={baseUrl}
          onChange={(e) => set({ baseUrl: e.target.value })}
        />
      </label>

      <label className="block text-sm">
        {t('apiKey')}
        <input
          type="password"
          autoComplete="off"
          className="mt-1 block w-full rounded border px-2 py-1"
          value={apiKey}
          onChange={(e) => set({ apiKey: e.target.value })}
        />
      </label>

      <label className="flex items-start gap-2 text-sm">
        <input type="checkbox" checked={rememberKey} onChange={(e) => set({ rememberKey: e.target.checked })} />
        <span>
          {t('remember')}
          {rememberKey && <span className="block text-xs text-amber-600">{t('rememberWarning')}</span>}
        </span>
      </label>

      <div className="flex gap-2">
        <button className="rounded bg-black px-3 py-1 text-sm text-white disabled:opacity-50" disabled={busy || !apiKey} onClick={load}>
          {t('loadModels')}
        </button>
      </div>

      <label className="block text-sm">
        {t('model')}
        <input
          list="model-list"
          className="mt-1 block w-full rounded border px-2 py-1"
          value={model}
          onChange={(e) => set({ model: e.target.value })}
        />
        <datalist id="model-list">{models.map((m) => <option key={m} value={m} />)}</datalist>
      </label>

      {status.kind === 'ok' && <p role="status" className="text-sm text-green-700">{t('connected', { count: status.count })}</p>}
      {status.kind === 'error' && <p role="alert" className="text-sm text-red-700">{t(status.message)}</p>}
    </section>
  );
}
