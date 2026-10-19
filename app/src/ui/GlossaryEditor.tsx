import { useEffect, useMemo, useRef, useState } from 'react';
import { saveAs } from 'file-saver';
import { Trans, useTranslation } from 'react-i18next';
import { library } from '@/checkpoint';
import { glossaryToJson, parseGlossaryFile, termsToCsv } from '@/glossary/io';
import { normalizeGender, type Glossary, type GlossaryTerm } from '@/glossary/models';
import { NameConflictError } from '@/library/store';
import { GlossaryPreviewDialog } from './GlossaryPreviewDialog';
import { NerDialog } from './NerDialog';

const CATEGORIES = ['character', 'location', 'organization', 'item', 'title', 'other'];

interface Row extends GlossaryTerm { key: number }
let rowKey = 0;
const toRows = (terms: GlossaryTerm[]): Row[] => terms.map((term) => ({ ...term, key: rowKey++ }));
const strip = ({ key: _key, ...term }: Row): GlossaryTerm => term;

/** Edits one glossary. Changes are saved as soon as a field loses focus. */
export function GlossaryEditor({ glossaryId, onBack, onDeleted }: { glossaryId: number; onBack: () => void; onDeleted: () => void }) {
  const { t } = useTranslation('glossary');
  const { t: tc } = useTranslation('common');
  const [glossary, setGlossary] = useState<Glossary | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [filter, setFilter] = useState('');
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [saving, setSaving] = useState<'idle' | 'saving' | 'saved'>('idle');
  const [message, setMessage] = useState<{ text: string; error?: boolean } | null>(null);
  const [dialog, setDialog] = useState<'ner' | 'preview' | null>(null);
  const importRef = useRef<HTMLInputElement>(null);

  const reload = async () => {
    const g = await library.getGlossary(glossaryId);
    if (!g) return onDeleted();
    setGlossary(g);
    setRows(toRows(g.terms));
  };
  useEffect(() => { void reload(); }, [glossaryId]); // eslint-disable-line react-hooks/exhaustive-deps

  /** Persists `next`; a repeated source is rejected so one term cannot silently replace another. */
  async function persist(next: Row[]) {
    const sources = next.map((r) => r.source.trim()).filter(Boolean);
    if (new Set(sources).size !== sources.length) {
      setMessage({ text: t('term_update_conflict'), error: true });
      return false;
    }
    setSaving('saving');
    await library.setTerms(glossaryId, next.map(strip));
    setSaving('saved');
    setMessage(null);
    return true;
  }

  const change = async (next: Row[]) => { setRows(next); await persist(next); };
  const edit = (key: number, patch: Partial<GlossaryTerm>) => setRows(rows.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  const commit = () => void persist(rows);

  async function saveMeta(patch: Partial<Pick<Glossary, 'name' | 'sourceLanguage' | 'targetLanguage'>>) {
    try {
      await library.updateGlossary(glossaryId, patch);
      setGlossary((g) => (g ? { ...g, ...patch } : g));
    } catch (err) {
      setMessage({ text: err instanceof NameConflictError ? t('name_conflict') : t('save_failed', { error: String(err) }), error: true });
      await reload();
    }
  }

  async function importFile(file: File | undefined) {
    if (!file) return;
    try {
      const terms = parseGlossaryFile(file.name, await file.text());
      const result = await library.replaceTerms(glossaryId, terms);
      await reload();
      const skipped = [
        result.skippedEmpty ? t('import_skipped_empty', { count: result.skippedEmpty }) : '',
        result.skippedDuplicate ? t('import_skipped_duplicate', { count: result.skippedDuplicate }) : '',
      ].filter(Boolean);
      setMessage({ text: t('import_success', { count: result.inserted }) + (skipped.length ? t('import_skipped_suffix', { details: skipped.join(t('list_separator')) }) : '') });
    } catch (err) {
      setMessage({ text: t('import_failed', { error: err instanceof Error ? err.message : String(err) }), error: true });
    } finally {
      if (importRef.current) importRef.current.value = '';
    }
  }

  async function deleteSelected() {
    if (!selected.size || !window.confirm(t('bulk_delete_confirm', { count: selected.size }))) return;
    await change(rows.filter((r) => !selected.has(r.key)));
    setMessage({ text: t('bulk_deleted', { count: selected.size }) });
    setSelected(new Set());
  }

  const visible = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return q ? rows.filter((r) => [r.source, r.target, r.category ?? '', r.gender ?? ''].some((v) => v.toLowerCase().includes(q))) : rows;
  }, [rows, filter]);

  if (!glossary) return null;

  return (
    <section className="space-y-3 rounded-lg border p-4 text-sm">
      <div className="flex items-center justify-between">
        <button className="rounded border px-2 py-1" title={t('editor_back_title')} onClick={onBack}>← {t('title')}</button>
        <span aria-live="polite" className="text-gray-600">{saving === 'saving' ? t('saving_indicator') : saving === 'saved' ? t('saved_indicator') : ''}</span>
      </div>
      <h2 className="font-medium">{t('editor_title')}</h2>

      <div className="grid grid-cols-3 gap-2">
        <label>{t('name_label')}<input className="mt-1 block w-full rounded border px-2 py-1" defaultValue={glossary.name} onBlur={(e) => e.target.value.trim() !== glossary.name && void saveMeta({ name: e.target.value })} /></label>
        <label>{t('source_label')}<input className="mt-1 block w-full rounded border px-2 py-1" defaultValue={glossary.sourceLanguage} onBlur={(e) => void saveMeta({ sourceLanguage: e.target.value })} /></label>
        <label>{t('target_label')}<input className="mt-1 block w-full rounded border px-2 py-1" defaultValue={glossary.targetLanguage} onBlur={(e) => void saveMeta({ targetLanguage: e.target.value })} /></label>
      </div>

      <div className="flex flex-wrap gap-2">
        <button className="rounded border px-2 py-1" onClick={() => setRows([...rows, ...toRows([{ source: '', target: '' }])])}>{t('add_term')}</button>
        <button className="rounded border px-2 py-1" onClick={() => setDialog('ner')}>{t('auto_extract')}</button>
        <button className="rounded border px-2 py-1" onClick={() => setDialog('preview')}>{t('preview')}</button>
        <button className="rounded border px-2 py-1" onClick={() => importRef.current?.click()}>{t('import')}</button>
        <input ref={importRef} type="file" hidden accept=".csv,.json" aria-label={t('import')} onChange={(e) => void importFile(e.target.files?.[0])} />
        <button className="rounded border px-2 py-1" title={t('export_csv_title')} onClick={() => saveAs(new Blob([termsToCsv(rows.map(strip))], { type: 'text/csv;charset=utf-8' }), `${glossary.name}.csv`)}>CSV</button>
        <button className="rounded border px-2 py-1" title={t('export_json_title')} onClick={() => saveAs(new Blob([glossaryToJson({ ...glossary, terms: rows.map(strip) })], { type: 'application/json' }), `${glossary.name}.json`)}>JSON</button>
        <button className="rounded border px-2 py-1" title={t('editor_delete_title')} onClick={async () => { if (window.confirm(t('confirm_delete_current'))) { await library.deleteGlossary(glossaryId); onDeleted(); } }}>{tc('delete')}</button>
      </div>

      {message && <p role={message.error ? 'alert' : 'status'} className={message.error ? 'text-red-700' : ''}>{message.text}</p>}

      <input aria-label={t('filter_terms_placeholder')} className="block w-full rounded border px-2 py-1" placeholder={t('filter_terms_placeholder')} value={filter} onChange={(e) => setFilter(e.target.value)} />
      {filter && <p className="text-gray-600">{t('term_filter_count', { visible: visible.length, total: rows.length })}</p>}
      {selected.size > 0 && <button className="rounded border px-2 py-1" onClick={() => void deleteSelected()}>{tc('delete')} ({selected.size})</button>}

      {rows.length === 0 ? (
        <p className="text-gray-600">{t('terms_empty')}</p>
      ) : (
        <table className="w-full text-left">
          <thead>
            <tr>
              <th><input type="checkbox" aria-label={t('select_all_aria')} checked={visible.length > 0 && visible.every((r) => selected.has(r.key))} onChange={(e) => setSelected(e.target.checked ? new Set(visible.map((r) => r.key)) : new Set())} /></th>
              <th title={t('source_header_title')}>{t('source_header')}</th><th>{t('target_header')}</th><th>{t('category_header')}</th><th title={t('gender_header_title')}>{t('gender_header')}</th><th />
            </tr>
          </thead>
          <tbody>
            {visible.map((r) => (
              <tr key={r.key}>
                <td><input type="checkbox" aria-label={r.source} checked={selected.has(r.key)} onChange={(e) => setSelected(new Set(e.target.checked ? [...selected, r.key] : [...selected].filter((k) => k !== r.key)))} /></td>
                <td><input aria-label={t('source_header')} className="w-full rounded border px-1" placeholder={t('term_source_placeholder')} value={r.source} onChange={(e) => edit(r.key, { source: e.target.value })} onBlur={commit} /></td>
                <td><input aria-label={t('target_header')} className="w-full rounded border px-1" value={r.target} onChange={(e) => edit(r.key, { target: e.target.value })} onBlur={commit} /></td>
                <td>
                  <select aria-label={t('category_header')} className="rounded border px-1" value={r.category ?? ''} onChange={(e) => void change(rows.map((x) => (x.key === r.key ? { ...x, category: e.target.value || null } : x)))}>
                    <option value="">{t('category_none')}</option>
                    {CATEGORIES.map((c) => <option key={c} value={c}>{t(`category_${c}`)}</option>)}
                  </select>
                </td>
                <td>
                  <select aria-label={t('gender_header')} className="rounded border px-1" title={t('gender_cell_title')} value={r.gender ?? ''} onChange={(e) => void change(rows.map((x) => (x.key === r.key ? { ...x, gender: normalizeGender(e.target.value) } : x)))}>
                    <option value="">{t('gender_unknown')}</option>
                    <option value="female">{t('gender_female')}</option>
                    <option value="male">{t('gender_male')}</option>
                  </select>
                </td>
                <td><button className="rounded border px-2" title={t('delete_term_title')} aria-label={t('delete_term_title')} onClick={() => void change(rows.filter((x) => x.key !== r.key))}>×</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p className="text-xs text-gray-600"><Trans t={t} i18nKey="inflected_forms_hint" components={{ code: <code /> }} /></p>
      <p className="text-xs text-gray-600">{t('autosave_hint')}</p>

      {dialog === 'ner' && <NerDialog glossary={{ ...glossary, terms: rows.map(strip) }} onClose={() => setDialog(null)} onAdded={(text) => { setMessage({ text }); void reload(); }} />}
      {dialog === 'preview' && <GlossaryPreviewDialog glossary={{ ...glossary, terms: rows.map(strip).filter((x) => x.source) }} onClose={() => setDialog(null)} />}
    </section>
  );
}
