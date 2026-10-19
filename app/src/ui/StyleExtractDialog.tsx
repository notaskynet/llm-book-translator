import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { library } from '@/checkpoint';
import { fileExtension, sampleFiles, UnsupportedFileError } from '@/documents/extraction';
import { SUPPORTED_EXTS } from '@/documents/sampler';
import { createProviderFromSettings } from '@/llm/fromSettings';
import type { StyleMode } from '@/prompts/prompts';
import { useTranslationOptions } from '@/store/translation';
import { assembleInstructions } from '@/style/assembler';
import { extractStyle, type ExtractedStyle } from '@/style/extractor';
import { Modal } from './Modal';

const MAX_FILES = 5;
const MAX_CHARS_CAP = 12000;

/** Extracts abstract style rules from sample books, lets the user pick the ones to keep, and saves a preset. */
export function StyleExtractDialog({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const { t } = useTranslation('style');
  const { sourceLanguage, targetLanguage } = useTranslationOptions();

  const [files, setFiles] = useState<File[]>([]);
  const [mode, setMode] = useState<StyleMode>('source');
  const [maxChars, setMaxChars] = useState(10000);
  const [sampleCount, setSampleCount] = useState(6);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [style, setStyle] = useState<ExtractedStyle | null>(null);
  const [checked, setChecked] = useState<boolean[]>([]);
  const [name, setName] = useState('');

  function pickFiles(list: FileList | null) {
    const picked = Array.from(list ?? []);
    setError(null);
    if (picked.length > MAX_FILES) return setError(t('too_many_files', { max: MAX_FILES }));
    const bad = picked.find((f) => !SUPPORTED_EXTS.includes(fileExtension(f.name)));
    if (bad) return setError(t('unsupported_file', { ext: fileExtension(bad.name).slice(1), accepted: SUPPORTED_EXTS.join(', ') }));
    setFiles(picked);
  }

  async function run() {
    setBusy(true);
    setError(null);
    setStyle(null);
    try {
      const sample = await sampleFiles(files, { maxChars: Math.min(maxChars, MAX_CHARS_CAP), sampleCount, minSampleSize: 1200 });
      if (!sample.text.trim()) throw new Error('no text');
      const { style: result, warnings } = await extractStyle(sample.text, mode, sourceLanguage, targetLanguage, createProviderFromSettings());
      if (!result.rules.length) throw new Error(warnings.at(-1) ?? 'no rules');
      setStyle(result);
      // Rules that quote the book or name specific words are left unchecked: reusing them breeds a tic.
      setChecked(result.rules.map((r) => r.flags.length === 0));
      setName(result.suggestedName);
    } catch (err) {
      setError(t('extract_failed', { error: err instanceof UnsupportedFileError ? err.message : err instanceof Error ? err.message : String(err) }));
    } finally {
      setBusy(false);
    }
  }

  const selected = useMemo(() => (style ? style.rules.filter((_, i) => checked[i]) : []), [style, checked]);
  const assembled = useMemo(() => assembleInstructions(mode, selected, style?.context ?? ''), [mode, selected, style]);
  const anyFlagged = style?.rules.some((r) => r.flags.length) ?? false;

  async function create() {
    if (!style) return;
    if (!selected.length) return setError(t('no_rules_selected'));
    try {
      await library.savePreset({
        name: name.trim() || style.suggestedName, description: style.summary, mode, context: style.context,
        sourceFiles: files.map((f) => f.name), generatedAt: new Date().toISOString(),
        rules: selected.map((r) => ({ dimension: r.dimension, instruction: r.instruction })),
        translation: assembled.translation, refinement: assembled.refinement,
      });
      onCreated();
      onClose();
    } catch (err) {
      setError(t('save_failed', { error: err instanceof Error ? err.message : String(err) }));
    }
  }

  return (
    <Modal title={t('extract_title')} onClose={onClose}>
      <div className="space-y-3 text-sm">
        {!style && (
          <>
            <label className="block">
              {t('extract_dropzone')}
              <input type="file" multiple accept={SUPPORTED_EXTS.join(',')} className="mt-1 block w-full" onChange={(e) => pickFiles(e.target.files)} />
            </label>
            {files.length > 0 && <p>{t('extract_file_count', { count: files.length })}</p>}

            <fieldset>
              <legend>{t('mode_label')}</legend>
              {(['source', 'model'] as const).map((m) => (
                <label key={m} className="mt-1 flex items-start gap-2">
                  <input type="radio" name="style-mode" checked={mode === m} onChange={() => setMode(m)} />
                  <span>{t(`mode_${m}`)}<span className="block text-xs text-gray-600">{t(`mode_${m}_hint`)}</span></span>
                </label>
              ))}
            </fieldset>

            <div className="flex gap-4">
              <label>
                {t('total_chars_label')}
                <input type="number" min={1000} max={MAX_CHARS_CAP} className="mt-1 block w-28 rounded border px-2 py-1" value={maxChars} onChange={(e) => setMaxChars(Number(e.target.value) || 10000)} />
              </label>
              <label>
                {t('sample_count_label')}
                <input type="number" min={1} max={20} className="mt-1 block w-20 rounded border px-2 py-1" value={sampleCount} onChange={(e) => setSampleCount(Math.min(20, Math.max(1, Number(e.target.value) || 6)))} />
              </label>
            </div>
            <button className="rounded bg-black px-3 py-1 text-white disabled:opacity-50" disabled={busy || !files.length} onClick={() => void run()}>
              {busy ? t('extracting') : t('run_extract')}
            </button>
          </>
        )}

        {style && (
          <>
            <h3 className="font-medium">{t('candidates_title')}</h3>
            <p className="text-gray-600">{t('candidates_hint')}</p>
            {anyFlagged && <p className="text-amber-700">{t('abstraction_notice')}</p>}
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={checked.every(Boolean)} onChange={(e) => setChecked(checked.map(() => e.target.checked))} />
              {t('select_all')}
            </label>
            <ul className="space-y-2">
              {style.rules.map((rule, i) => (
                <li key={i} className="flex items-start gap-2">
                  <input type="checkbox" aria-label={rule.instruction} checked={checked[i] ?? false} onChange={(e) => setChecked(checked.map((c, j) => (j === i ? e.target.checked : c)))} />
                  <span>
                    <span className="mr-2 rounded bg-gray-100 px-1 text-xs">{t(`dimension_${rule.dimension}`)}</span>
                    <span title={`${t('evidence_tooltip')}: ${rule.evidence}`}>{rule.instruction}</span>
                    {rule.flags.map((f) => <span key={f} className="ml-1 rounded bg-amber-100 px-1 text-xs">{t(`flag_${f}`)}</span>)}
                  </span>
                </li>
              ))}
            </ul>
            <label className="block">
              {t('preset_name_label')}
              <input className="mt-1 block w-full rounded border px-2 py-1" value={name} onChange={(e) => setName(e.target.value)} />
            </label>
            <details>
              <summary className="cursor-pointer">{t('preview_title')}</summary>
              <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap text-xs">{assembled.translation}</pre>
            </details>
            <button className="rounded bg-black px-3 py-1 text-white" onClick={() => void create()}>{t('create_preset')}</button>
          </>
        )}
        {error && <p role="alert" className="text-red-700">{error}</p>}
      </div>
    </Modal>
  );
}
