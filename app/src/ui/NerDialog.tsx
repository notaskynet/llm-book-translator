import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { library } from '@/checkpoint';
import { fileExtension, sampleFiles, UnsupportedFileError } from '@/documents/extraction';
import { SUPPORTED_EXTS } from '@/documents/sampler';
import type { Glossary } from '@/glossary/models';
import { suggestTerms, type NerCandidate } from '@/glossary/ner';
import { createProviderFromSettings } from '@/llm/fromSettings';
import { Modal } from './Modal';

const MAX_CHARS = 6000;

interface Row extends NerCandidate { checked: boolean; existing: boolean }

/** Suggests glossary terms from a book. Nothing is added until the user ticks it. */
export function NerDialog({ glossary, onClose, onAdded }: { glossary: Glossary; onClose: () => void; onAdded: (message: string) => void }) {
  const { t } = useTranslation('glossary');
  const [file, setFile] = useState<File | null>(null);
  const [maxChars, setMaxChars] = useState(MAX_CHARS);
  const [sampleCount, setSampleCount] = useState(10);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rows, setRows] = useState<Row[] | null>(null);

  async function run() {
    if (!file) return setError(t('ner_no_file_selected'));
    if (!SUPPORTED_EXTS.includes(fileExtension(file.name))) {
      return setError(t('ner_unsupported_ext', { ext: fileExtension(file.name).slice(1), accepted: SUPPORTED_EXTS.join(', ') }));
    }
    setBusy(true);
    setError(null);
    try {
      const sample = await sampleFiles([file], { maxChars: Math.min(maxChars, MAX_CHARS), sampleCount, minSampleSize: 500 });
      if (!sample.text.trim()) throw new Error('no text');
      const { candidates, warnings } = await suggestTerms(sample.text, glossary.sourceLanguage || 'the source language', glossary.targetLanguage || 'English', createProviderFromSettings());
      if (!candidates.length) throw new Error(warnings.at(-1) ?? 'no candidates');
      const known = new Set(glossary.terms.map((x) => x.source));
      // Pairs where source equals target are left unticked; the user can still include them.
      setRows(candidates.map((c) => ({ ...c, existing: known.has(c.source), checked: !known.has(c.source) && c.source !== c.target })));
    } catch (err) {
      setError(t('ner_extract_failed', { error: err instanceof UnsupportedFileError ? err.message : err instanceof Error ? err.message : String(err) }));
    } finally {
      setBusy(false);
    }
  }

  async function add() {
    const picked = (rows ?? []).filter((r) => r.checked && !r.existing);
    if (!picked.length) return setError(t('ner_no_candidates_selected'));
    const result = await library.addTerms(glossary.id!, picked.map((r) => ({
      source: r.source, target: r.target, category: r.category === 'other' ? null : r.category, gender: r.gender === 'male' || r.gender === 'female' ? r.gender : null,
    })));
    onAdded(t('ner_added_summary', { count: result.added }) + (result.conflicts ? t('ner_added_with_conflicts', { count: result.conflicts }) : ''));
    onClose();
  }

  const update = (i: number, patch: Partial<Row>) => setRows((rows ?? []).map((r, j) => (j === i ? { ...r, ...patch } : r)));

  return (
    <Modal title={t('ner_modal_title')} onClose={onClose}>
      <div className="space-y-3 text-sm">
        {!rows && (
          <>
            <label className="block">
              {t('ner_choose_file')}
              <input type="file" accept={SUPPORTED_EXTS.join(',')} className="mt-1 block w-full" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
            </label>
            <div className="flex gap-4">
              <label>
                {t('ner_total_chars')}
                <input type="number" min={500} max={MAX_CHARS} className="mt-1 block w-28 rounded border px-2 py-1" value={maxChars} onChange={(e) => setMaxChars(Number(e.target.value) || MAX_CHARS)} />
              </label>
              <label>
                {t('ner_samples')}
                <input type="number" min={1} max={50} className="mt-1 block w-20 rounded border px-2 py-1" value={sampleCount} onChange={(e) => setSampleCount(Math.min(50, Math.max(1, Number(e.target.value) || 10)))} />
              </label>
            </div>
            <button className="rounded bg-accent px-3 py-1 text-accent-fg disabled:opacity-50" disabled={busy} onClick={() => void run()}>
              {busy ? t('ner_extracting') : t('ner_extract_btn')}
            </button>
          </>
        )}
        {rows && (
          <>
            <p className="text-amber-700">{t('ner_warning')}</p>
            <p>{rows.length} {t('ner_candidates_count')}</p>
            <table className="w-full text-left">
              <thead><tr><th /><th>{t('source_header')}</th><th>{t('ner_target_editable')}</th><th>{t('category_header')}</th><th>{t('gender_header')}</th></tr></thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={r.source} className={r.existing || r.source === r.target ? 'opacity-60' : ''}>
                    <td><input type="checkbox" aria-label={r.source} disabled={r.existing} checked={r.checked} onChange={(e) => update(i, { checked: e.target.checked })} /></td>
                    <td>{r.source}{r.existing && t('ner_already_in_glossary')}{!r.existing && r.source === r.target && t('ner_identical_pair')}</td>
                    <td><input className="w-full rounded border px-1" value={r.target} onChange={(e) => update(i, { target: e.target.value })} /></td>
                    <td>{t(`category_${r.category}`, { defaultValue: r.category })}</td>
                    <td>{r.gender ? t(`gender_${r.gender}`) : t('gender_unknown')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <button className="rounded bg-accent px-3 py-1 text-accent-fg" onClick={() => void add()}>{t('ner_add_selected')}</button>
          </>
        )}
        {error && <p role="alert" className="text-red-700">{error}</p>}
      </div>
    </Modal>
  );
}
