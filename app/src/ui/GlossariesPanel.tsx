import { useRef, useState } from 'react';
import { saveAs } from 'file-saver';
import { useLiveQuery } from 'dexie-react-hooks';
import { Trans, useTranslation } from 'react-i18next';
import { library } from '@/checkpoint';
import { glossaryToJson, parseGlossaryFile, termsToCsv } from '@/glossary/io';
import { NameConflictError } from '@/library/store';
import { useTranslationOptions } from '@/store/translation';
import { GlossaryEditor } from './GlossaryEditor';

export function GlossariesPanel() {
  const { t } = useTranslation('glossary');
  const { t: tc } = useTranslation('common');
  const glossaries = useLiveQuery(() => library.listGlossaries(), []) ?? [];
  const { glossaryId, sourceLanguage, targetLanguage, set } = useTranslationOptions();
  const [editingId, setEditingId] = useState<number | null>(null);
  const [newName, setNewName] = useState('');
  const [message, setMessage] = useState<{ text: string; error?: boolean } | null>(null);
  const importRef = useRef<HTMLInputElement>(null);

  const fail = (text: string) => setMessage({ text, error: true });

  async function create() {
    if (!newName.trim()) return;
    try {
      const g = await library.createGlossary({ name: newName, sourceLanguage, targetLanguage });
      setNewName('');
      setEditingId(g.id!);
      setMessage({ text: t('new_glossary_created') });
    } catch (err) {
      fail(err instanceof NameConflictError ? t('name_conflict') : t('create_failed', { error: String(err) }));
    }
  }

  async function importAsNew(file: File | undefined) {
    if (!file) return;
    try {
      const terms = parseGlossaryFile(file.name, await file.text());
      let name = file.name.replace(/\.(csv|json)$/i, '');
      for (let n = 2; (await library.listGlossaries()).some((g) => g.name === name); n++) name = `${file.name.replace(/\.(csv|json)$/i, '')} (${n})`;
      const g = await library.createGlossary({ name, sourceLanguage, targetLanguage, terms });
      setMessage({ text: t('import_success', { count: g.terms.length }) });
    } catch (err) {
      fail(t('import_failed', { error: err instanceof Error ? err.message : String(err) }));
    } finally {
      if (importRef.current) importRef.current.value = '';
    }
  }

  async function duplicate(id: number, name: string) {
    let copyName = `${name} (copy)`;
    for (let n = 2; (await library.listGlossaries()).some((g) => g.name === copyName); n++) copyName = `${name} (copy ${n})`;
    try {
      const copy = await library.duplicateGlossary(id, copyName);
      setMessage({ text: t('duplicated_as', { name: copy.name }) });
    } catch (err) {
      fail(t('duplicate_failed', { error: String(err) }));
    }
  }

  async function remove(id: number, name: string) {
    if (!window.confirm(t('confirm_delete_with_undone', { name }))) return;
    await library.deleteGlossary(id);
    if (glossaryId === id) set({ glossaryId: null });
    setMessage({ text: t('deleted_glossary', { name }) });
  }

  if (editingId !== null) {
    return <GlossaryEditor glossaryId={editingId} onBack={() => setEditingId(null)} onDeleted={() => { if (glossaryId === editingId) set({ glossaryId: null }); setEditingId(null); }} />;
  }

  return (
    <section className="space-y-4 rounded-lg border p-4">
      <h2 className="font-medium">{t('title')}</h2>
      <p className="text-sm text-gray-600"><Trans t={t} i18nKey="list_intro" components={{ strong: <strong /> }} /></p>
      <div className="flex flex-wrap items-end gap-2 text-sm">
        <label>
          {t('name_label')}
          <input className="mt-1 block rounded border px-2 py-1" value={newName} onChange={(e) => setNewName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void create()} />
        </label>
        <button className="rounded bg-accent px-3 py-1 text-accent-fg disabled:opacity-50" disabled={!newName.trim()} onClick={() => void create()}>{t('new_glossary')}</button>
        <button className="rounded border px-3 py-1" onClick={() => importRef.current?.click()}>{t('import_csv_json')}</button>
        <input ref={importRef} type="file" hidden accept=".csv,.json" aria-label={t('import_csv_json')} onChange={(e) => void importAsNew(e.target.files?.[0])} />
      </div>
      {message && <p role={message.error ? 'alert' : 'status'} className={`text-sm ${message.error ? 'text-red-700' : ''}`}>{message.text}</p>}

      {glossaries.length === 0 ? (
        <p className="text-sm text-gray-600">{t('list_empty_message')}</p>
      ) : (
        <ul className="divide-y text-sm">
          {glossaries.map((g) => {
            const active = glossaryId === g.id;
            return (
              <li key={g.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <span className="min-w-0">
                  <span className="font-medium">{g.name}</span>
                  <span className="ml-2 text-gray-600">{t('term_count', { count: g.terms.length })}{g.sourceLanguage || g.targetLanguage ? ` · ${g.sourceLanguage || '?'} → ${g.targetLanguage || '?'}` : ''}</span>
                </span>
                <span className="flex gap-2">
                  <button
                    className={`rounded border px-2 py-1 ${active ? 'bg-accent text-accent-fg' : ''}`}
                    aria-pressed={active}
                    title={active ? t('unassign_title') : t('assign_title')}
                    onClick={() => { set({ glossaryId: active ? null : g.id! }); setMessage({ text: t(active ? 'unassigned_msg' : 'assigned_msg', { name: g.name }) }); }}
                  >
                    {active ? '✓' : '○'} <span className="sr-only">{active ? t('unassign_title') : t('assign_title')}</span>
                  </button>
                  <button className="rounded border px-2 py-1" title={t('edit_glossary_title')} onClick={() => setEditingId(g.id!)}>{t('edit_glossary_title')}</button>
                  <button className="rounded border px-2 py-1" title={t('duplicate_glossary_title')} onClick={() => void duplicate(g.id!, g.name)}>{t('duplicate_glossary')}</button>
                  <button className="rounded border px-2 py-1" title={t('export_csv_title')} onClick={() => saveAs(new Blob([termsToCsv(g.terms)], { type: 'text/csv;charset=utf-8' }), `${g.name}.csv`)}>CSV</button>
                  <button className="rounded border px-2 py-1" title={t('export_json_title')} onClick={() => saveAs(new Blob([glossaryToJson(g)], { type: 'application/json' }), `${g.name}.json`)}>JSON</button>
                  <button className="rounded border px-2 py-1" onClick={() => void remove(g.id!, g.name)}>{tc('delete')}</button>
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
