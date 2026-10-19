import { useRef, useState } from 'react';
import { saveAs } from 'file-saver';
import { useLiveQuery } from 'dexie-react-hooks';
import { useTranslation } from 'react-i18next';
import { library } from '@/checkpoint';
import { serializePreset, slugifyPresetName, type Preset } from '@/presets/format';
import { useTranslationOptions } from '@/store/translation';
import { StyleEditor } from './StyleEditor';
import { StyleExtractDialog } from './StyleExtractDialog';

export function StylesPanel() {
  const { t } = useTranslation('style');
  const { t: tc } = useTranslation('common');
  const { t: tg } = useTranslation('glossary');
  const presets = useLiveQuery(() => library.listPresets(), []) ?? [];
  const { presetId, set } = useTranslationOptions();
  const [editing, setEditing] = useState<Preset | null | 'new'>(null);
  const [extracting, setExtracting] = useState(false);
  const [message, setMessage] = useState<{ text: string; error?: boolean } | null>(null);
  const importRef = useRef<HTMLInputElement>(null);

  async function importFile(file: File | undefined) {
    if (!file) return;
    try {
      const existing = await library.getPreset(slugifyPresetName(file.name.replace(/\.(txt|ya?ml)$/i, '')));
      if (existing && !window.confirm(t('confirm_overwrite', { name: existing.name }))) return;
      const preset = await library.importPresetFile(file.name, await file.text());
      setMessage({ text: t('saved') + `: ${preset.name}` });
    } catch (err) {
      setMessage({ text: t('save_failed', { error: err instanceof Error ? err.message : String(err) }), error: true });
    } finally {
      if (importRef.current) importRef.current.value = '';
    }
  }

  async function remove(preset: Preset) {
    if (!window.confirm(t('confirm_delete', { name: preset.name }))) return;
    await library.deletePreset(preset.id);
    if (presetId === preset.id) set({ presetId: null });
    setMessage({ text: t('deleted') });
  }

  return (
    <section className="space-y-4 rounded-lg border p-4">
      <h2 className="font-medium">{t('title')}</h2>
      <div className="flex flex-wrap gap-2 text-sm">
        <button className="rounded bg-black px-3 py-1 text-white" onClick={() => setExtracting(true)}>{t('new_from_books')}</button>
        <button className="rounded border px-3 py-1" onClick={() => setEditing('new')}>{t('new_blank')}</button>
        <button className="rounded border px-3 py-1" onClick={() => importRef.current?.click()}>{tg('import')}</button>
        <input ref={importRef} type="file" hidden accept=".yaml,.yml,.txt" aria-label={tg('import')} onChange={(e) => void importFile(e.target.files?.[0])} />
      </div>
      {message && <p role={message.error ? 'alert' : 'status'} className={`text-sm ${message.error ? 'text-red-700' : ''}`}>{message.text}</p>}

      {presets.length === 0 ? (
        <p className="text-sm text-gray-600">{t('list_empty_message')}</p>
      ) : (
        <ul className="divide-y text-sm">
          {presets.map((p) => {
            const active = presetId === p.id;
            return (
              <li key={p.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <span className="min-w-0">
                  <span className="font-medium">{p.name}</span>
                  {p.mode && <span className="ml-2 rounded bg-gray-100 px-1 text-xs">{t(`mode_${p.mode}`)}</span>}
                  {p.description && <span className="block truncate text-gray-600">{p.description}</span>}
                </span>
                <span className="flex gap-2">
                  <button
                    className={`rounded border px-2 py-1 ${active ? 'bg-black text-white' : ''}`}
                    aria-pressed={active}
                    title={active ? t('unassign_title') : t('assign_title')}
                    onClick={() => { set({ presetId: active ? null : p.id }); setMessage({ text: t(active ? 'unassigned_msg' : 'assigned_msg', { name: p.name }) }); }}
                  >
                    {active ? '✓' : '○'} <span className="sr-only">{active ? t('unassign_title') : t('assign_title')}</span>
                  </button>
                  <button className="rounded border px-2 py-1" onClick={() => setEditing(p)}>{t('edit')}</button>
                  <button className="rounded border px-2 py-1" onClick={() => saveAs(new Blob([serializePreset(p)], { type: 'text/yaml;charset=utf-8' }), `${p.id}.yaml`)}>{t('export')}</button>
                  <button className="rounded border px-2 py-1" onClick={() => void remove(p)}>{tc('delete')}</button>
                </span>
              </li>
            );
          })}
        </ul>
      )}

      {editing !== null && (
        <StyleEditor preset={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onSaved={() => setMessage({ text: t('saved') })} />
      )}
      {extracting && <StyleExtractDialog onClose={() => setExtracting(false)} onCreated={() => setMessage({ text: t('created') })} />}
    </section>
  );
}
