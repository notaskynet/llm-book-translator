import { useMemo, useRef, useState } from 'react';
import { diffWords } from 'diff';
import { useLiveQuery } from 'dexie-react-hooks';
import { useTranslation } from 'react-i18next';
import { library } from '@/checkpoint';
import type { GlossaryOptions } from '@/glossary/chunkBlock';
import { termsMap, termsMetadata } from '@/glossary/models';
import { DocumentTooSmallError, initialSamples, itemsForIndices, loadSourceUnits, pickRandomUnusedIndex, type SampleItem, type SampleWarning, type SourceUnit } from '@/sample/items';
import { runSample, type CellKey, type CellResult, type ColumnSetup, type SampleColumn, type SampleMode } from '@/sample/run';
import { SUPPORTED_EXTS } from '@/documents/sampler';
import { useSettings } from '@/store/settings';
import { useTranslationOptions } from '@/store/translation';

const MAX_COLUMNS = 4;
const DEFAULTS = { samples: 5, maxChars: 400 };
let columnId = 0;

const resultKey = (item: SampleItem, column: SampleColumn, phase: string) => `${item.index}|${item.sourceText.length}|${column.id}|${phase}`;

/** Words of `text` that are not in `base`, highlighted. */
function Highlighted({ text, base }: { text: string; base: string }) {
  return (
    <>
      {diffWords(base, text).filter((p) => !p.removed).map((p, i) => (p.added ? <mark key={i} className="bg-yellow-200">{p.value}</mark> : <span key={i}>{p.value}</span>))}
    </>
  );
}

export function SamplePanel() {
  const { t } = useTranslation('sample');
  const { t: tt } = useTranslation('translate');
  const { t: tc } = useTranslation('connection');
  const presets = useLiveQuery(() => library.listPresets(), []) ?? [];
  const glossaries = useLiveQuery(() => library.listGlossaries(), []) ?? [];
  const { baseUrl, apiKey, model, models, set: setSettings } = useSettings();
  const { sourceLanguage, targetLanguage } = useTranslationOptions();

  const [fileName, setFileName] = useState<string | null>(null);
  const [units, setUnits] = useState<SourceUnit[]>([]);
  const [items, setItems] = useState<SampleItem[]>([]);
  const [warning, setWarning] = useState<SampleWarning | null>(null);
  const [mode, setMode] = useState<SampleMode>('translate');
  const [samples, setSamples] = useState(DEFAULTS.samples);
  const [maxChars, setMaxChars] = useState(DEFAULTS.maxChars);
  const [columns, setColumns] = useState<SampleColumn[]>(() => [{ id: `c${columnId++}`, model, presetId: null, glossaryId: null }]);
  const [results, setResults] = useState<Map<string, CellResult>>(new Map());
  const [pending, setPending] = useState<Set<string>>(new Set());
  const [running, setRunning] = useState(false);
  const [highlight, setHighlight] = useState(false);
  const [message, setMessage] = useState<{ text: string; error?: boolean } | null>(null);
  const abort = useRef<AbortController | null>(null);

  const fail = (text: string) => setMessage({ text, error: true });
  const phases = mode === 'translate_refine' ? (['translate', 'refine'] as const) : ([mode] as const);

  async function pickFile(file: File | undefined) {
    if (!file) return;
    setMessage(null);
    try {
      const loaded = await loadSourceUnits(file);
      const { items: initial, warning: w } = initialSamples(loaded, samples, maxChars);
      setFileName(file.name);
      setUnits(loaded);
      setItems(initial);
      setWarning(w);
      setResults(new Map());
    } catch (err) {
      fail(t('initialize_failed', { error: err instanceof DocumentTooSmallError || err instanceof Error ? err.message : String(err) }));
    }
  }

  /** Re-samples with the new N and size; extracts whose text did not change keep their results. */
  function updateSamples() {
    try {
      const { items: next, warning: w } = initialSamples(units, samples, maxChars);
      setItems(next);
      setWarning(w);
    } catch (err) {
      fail(t('initialize_failed', { error: err instanceof Error ? err.message : String(err) }));
    }
  }

  function addSample() {
    const index = pickRandomUnusedIndex(units.length, new Set(items.map((i) => i.index)));
    if (index === null) return fail(t('no_more_indices'));
    setItems([...items, ...itemsForIndices(units, [index], maxChars)]);
  }

  async function setupFor(column: SampleColumn): Promise<ColumnSetup> {
    const preset = column.presetId ? await library.getPreset(column.presetId) : undefined;
    const glossary = column.glossaryId != null ? await library.getGlossary(column.glossaryId) : undefined;
    const glossaryOptions: GlossaryOptions | undefined = glossary?.terms.length ? { terms: termsMap(glossary.terms), metadata: termsMetadata(glossary.terms) } : undefined;
    return {
      promptOptions: { custom_instructions: preset?.translation ?? '', refinement_instructions: preset?.refinement ?? '' },
      glossary: glossaryOptions,
    };
  }

  async function run(only?: CellKey[]) {
    if (!fileName) return fail(t('error_no_file'));
    if (!items.length) return fail(t('error_no_samples'));
    const missing = columns.findIndex((c) => !c.model.trim());
    if (missing !== -1) return fail(t('error_llm_missing_model', { index: missing + 1 }));

    setMessage(null);
    const controller = new AbortController();
    abort.current = controller;
    setRunning(true);

    // Without an explicit selection only the cells that have no result yet are run.
    const lastPhase = phases[phases.length - 1];
    const cells = only ?? items.flatMap((item, row) => columns.map((c, col) => ({ row, col, done: results.has(resultKey(item, c, lastPhase)) })).filter((c) => !c.done).map(({ row, col }) => ({ row, col })));
    setPending(new Set(cells.map((c) => `${items[c.row].index}|${columns[c.col].id}`)));

    try {
      await runSample({
        items, columns, setups: await Promise.all(columns.map(setupFor)), only: cells, signal: controller.signal,
        ctx: { baseUrl, apiKeys: apiKey, sourceLanguage, targetLanguage, mode },
        onUpdate: ({ row, col, phase, result }) => {
          setResults((prev) => new Map(prev).set(resultKey(items[row], columns[col], phase), result));
          if (phase === lastPhase || result.status === 'error') {
            setPending((prev) => { const next = new Set(prev); next.delete(`${items[row].index}|${columns[col].id}`); return next; });
          }
        },
      });
      setMessage({ text: t(controller.signal.aborted ? 'run_stopped' : 'run_done') });
    } catch (err) {
      fail(t('error_run', { error: err instanceof Error ? err.message : String(err) }));
    } finally {
      setRunning(false);
      setPending(new Set());
      abort.current = null;
    }
  }

  const outputOf = (item: SampleItem, column: SampleColumn, phase: 'translate' | 'refine') => results.get(resultKey(item, column, phase));

  const markdown = useMemo(() => {
    const esc = (s: string) => s.replace(/\|/g, '\\|').replace(/\n/g, '<br>');
    const header = ['Source', ...columns.map((c, i) => `${t('llm_label', { index: i + 1 })} (${c.model})`)];
    const rows = items.map((item) => [
      esc(item.sourceText),
      ...columns.map((c) => esc(phases.map((p) => outputOf(item, c, p)?.output ?? '').filter(Boolean).join('\n\n'))),
    ]);
    return [header, header.map(() => '---'), ...rows].map((r) => `| ${r.join(' | ')} |`).join('\n');
  }, [items, columns, results, mode]); // eslint-disable-line react-hooks/exhaustive-deps

  async function copyMarkdown() {
    try {
      await navigator.clipboard.writeText(markdown);
      setMessage({ text: t('copied_to_clipboard') });
    } catch (err) {
      fail(t('copy_failed', { error: err instanceof Error ? err.message : String(err) }));
    }
  }

  const updateColumn = (id: string, patch: Partial<SampleColumn>) => setColumns(columns.map((c) => (c.id === id ? { ...c, ...patch } : c)));

  return (
    <section className="space-y-4 rounded-lg border p-4 text-sm">
      <h2 className="font-medium">{t('title')}</h2>
      <p className="text-gray-600">{t('subtitle')}</p>

      <label className="block">
        {t('drop_file_title')}
        <input type="file" accept={SUPPORTED_EXTS.join(',')} className="mt-1 block w-full" disabled={running} onChange={(e) => void pickFile(e.target.files?.[0])} />
      </label>
      {fileName && <p>{t('selected_file')}: <strong>{fileName}</strong></p>}

      <fieldset className="flex flex-wrap gap-4" disabled={running}>
        <legend className="sr-only">{t('mode_label')}</legend>
        {(['translate', 'refine', 'translate_refine'] as const).map((m) => (
          <label key={m} className="flex items-center gap-2">
            <input type="radio" name="sample-mode" checked={mode === m} onChange={() => setMode(m)} />
            {t(`mode_${m}`)}
          </label>
        ))}
      </fieldset>

      <div className="flex flex-wrap items-end gap-3">
        <label>
          {t('n_samples_label')}
          <input type="number" min={2} max={20} className="mt-1 block w-20 rounded border px-2 py-1" value={samples} onChange={(e) => setSamples(Math.min(20, Math.max(2, Number(e.target.value) || DEFAULTS.samples)))} />
        </label>
        <label>
          {t('max_chars_label')}
          <input type="number" min={50} max={2000} className="mt-1 block w-24 rounded border px-2 py-1" value={maxChars} onChange={(e) => setMaxChars(Math.min(2000, Math.max(50, Number(e.target.value) || DEFAULTS.maxChars)))} />
        </label>
        <button className="rounded border px-3 py-1 disabled:opacity-50" title={t('update_samples_title')} disabled={!units.length || running} onClick={updateSamples}>{t('update_samples')}</button>
      </div>

      <fieldset className="space-y-2">
        <legend className="font-medium">{t('llms_label')}</legend>
        <datalist id="sample-models">{models.map((m) => <option key={m} value={m} />)}</datalist>
        {columns.map((c, i) => (
          <div key={c.id} className="flex flex-wrap items-end gap-2 rounded border p-2">
            <span className="font-medium">{t('llm_label', { index: i + 1 })}</span>
            <label>
              {tc('model')}
              <input list="sample-models" className="mt-1 block w-48 rounded border px-2 py-1" value={c.model} disabled={running} onChange={(e) => updateColumn(c.id, { model: e.target.value })} />
            </label>
            <label>
              {tt('style_select')}
              <select aria-label={`${tt('style_select')} ${i + 1}`} className="mt-1 block rounded border px-2 py-1" value={c.presetId ?? ''} disabled={running} onChange={(e) => updateColumn(c.id, { presetId: e.target.value || null })}>
                <option value="">{tt('none')}</option>
                {presets.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </label>
            <label>
              {tt('glossary_select')}
              <select aria-label={`${tt('glossary_select')} ${i + 1}`} className="mt-1 block rounded border px-2 py-1" value={c.glossaryId ?? ''} disabled={running} onChange={(e) => updateColumn(c.id, { glossaryId: e.target.value ? Number(e.target.value) : null })}>
                <option value="">{tt('none')}</option>
                {glossaries.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
              </select>
            </label>
            <button className="rounded border px-2 py-1" title={t('apply_to_settings_title')} onClick={() => { setSettings({ model: c.model }); setMessage({ text: t('applied_to_settings') }); }}>{t('apply_to_settings')}</button>
            {columns.length > 1 && <button className="rounded border px-2 py-1" title={t('remove_llm')} aria-label={`${t('remove_llm')} ${i + 1}`} disabled={running} onClick={() => setColumns(columns.filter((x) => x.id !== c.id))}>×</button>}
          </div>
        ))}
        {columns.length < MAX_COLUMNS && (
          <button className="rounded border px-3 py-1" disabled={running} onClick={() => setColumns([...columns, { id: `c${columnId++}`, model, presetId: null, glossaryId: null }])}>{t('add_llm')}</button>
        )}
      </fieldset>

      <div className="flex flex-wrap items-center gap-2">
        {running ? (
          <button className="rounded border px-3 py-1" onClick={() => abort.current?.abort()}>{t('stop')}</button>
        ) : (
          <button className="rounded bg-accent px-3 py-1 text-accent-fg" onClick={() => void run()}>{t('run')}</button>
        )}
        <button className="rounded border px-3 py-1 disabled:opacity-50" disabled={!items.length} onClick={() => void copyMarkdown()}>{t('copy_markdown')}</button>
        {columns.length > 1 && (
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={highlight} onChange={(e) => setHighlight(e.target.checked)} />
            {t('highlight_differences')}
          </label>
        )}
      </div>

      {warning && <p role="note" className="text-amber-700">{t('warning_small_document', { ...warning })}</p>}
      {message && <p role={message.error ? 'alert' : 'status'} className={message.error ? 'text-red-700' : ''}>{message.text}</p>}

      {items.length === 0 ? (
        <p className="text-gray-600">{fileName ? t('no_samples_left') : t('no_results_yet')}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[40rem] border-collapse text-left align-top">
            <thead>
              <tr>
                <th className="w-1/4 border p-2">{t('source_col_header')}</th>
                {columns.map((c, i) => <th key={c.id} className="border p-2">{t('llm_label', { index: i + 1 })} <span className="font-normal text-gray-600">{c.model}</span></th>)}
              </tr>
            </thead>
            <tbody>
              {items.map((item, row) => (
                <tr key={`${item.index}-${row}`}>
                  <td className="border p-2">
                    <p className="whitespace-pre-wrap">{item.sourceText}</p>
                    {item.truncated && <span className="mr-1 rounded bg-gray-100 px-1 text-xs">{t('badge_truncated')}</span>}
                    <button className="mt-1 text-xs underline" disabled={running} onClick={() => setItems(items.filter((_, r) => r !== row))}>{t('remove_sample')}</button>
                  </td>
                  {columns.map((c, col) => {
                    const first = columns[0];
                    return (
                      <td key={c.id} className="border p-2">
                        {phases.map((phase) => {
                          const cell = outputOf(item, c, phase);
                          if (!cell) {
                            if (phase !== phases[0]) return null;
                            return pending.has(`${item.index}|${c.id}`)
                              ? <span key={phase} className="text-gray-500">…</span>
                              : <button key={phase} className="text-left text-gray-600 underline" disabled={running} onClick={() => void run([{ row, col }])}>{t('cell_pending')}</button>;
                          }
                          const base = col > 0 && highlight ? outputOf(item, first, phase)?.output : null;
                          return (
                            <div key={phase} className="mb-2">
                              {phases.length > 1 && <span className="mb-1 block text-xs font-medium text-gray-600">{t(phase === 'translate' ? 'phase_translated' : 'phase_refined')}</span>}
                              {cell.status === 'error' ? (
                                <p className="text-red-700"><span className="mr-1 rounded bg-red-100 px-1 text-xs">{t('badge_error')}</span>{cell.error}</p>
                              ) : (
                                <p className="whitespace-pre-wrap">{base ? <Highlighted text={cell.output ?? ''} base={base} /> : cell.output}</p>
                              )}
                              <p className="mt-1 text-xs text-gray-500">
                                {(cell.metrics.latencyMs / 1000).toFixed(1)}s
                                {cell.metrics.completionTokens ? ` · ${cell.metrics.promptTokens}→${cell.metrics.completionTokens} tok` : ''}
                                {cell.metrics.lengthRatio !== undefined ? ` · ×${cell.metrics.lengthRatio}` : ''}
                                {cell.metrics.wasFallback && <span className="ml-1 rounded bg-amber-100 px-1">{t('badge_fallback')}</span>}
                                {cell.metrics.wasTruncated && <span className="ml-1 rounded bg-amber-100 px-1">{t('badge_truncated')}</span>}
                              </p>
                            </div>
                          );
                        })}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {items.length > 0 && units.length > 0 && (
        <button className="rounded border px-3 py-1" disabled={running} onClick={addSample}>{t('add_sample')}</button>
      )}
    </section>
  );
}
