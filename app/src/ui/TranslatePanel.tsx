import { useEffect, useState } from 'react';
import { useDropzone } from 'react-dropzone';
import { saveAs } from 'file-saver';
import { useTranslation } from 'react-i18next';
import { isSupportedFile, SUPPORTED_EXTENSIONS } from '@/formats';
import { useSettings } from '@/store/settings';
import { useTranslationOptions } from '@/store/translation';
import { discardJob, refreshResumable, resetJob, resumeJob, startJob, stopJob, useJob } from '@/translate/jobController';

const LANGUAGES = [
  'English', 'French', 'Spanish', 'German', 'Italian', 'Portuguese', 'Russian', 'Ukrainian', 'Polish', 'Dutch',
  'Turkish', 'Arabic', 'Hebrew', 'Hindi', 'Chinese', 'Japanese', 'Korean', 'Vietnamese', 'Thai', 'Indonesian',
];

// Engine events worth showing to the user; everything else stays out of the activity log.
const VISIBLE_EVENTS = new Set([
  'checkpoint_resumed', 'unit_failed', 'unit_error', 'unit_validation_failed', 'unit_validation_exhausted',
  'empty_llm_response', 'output_truncated', 'unclosed_translation_tag', 'context_overflow_retry',
  'context_overflow_fatal', 'llm_key_rotated', 'llm_rate_limit', 'llm_request_failed',
  'translation_interrupted', 'rate_limited', 'using_raw_response_fallback',
]);

export function TranslatePanel() {
  const { t, i18n } = useTranslation('translate');
  const options = useTranslationOptions();
  const { apiKey, model } = useSettings();
  const job = useJob();
  const [error, setError] = useState<string | null>(null);
  const ready = Boolean(model) && Boolean(apiKey);
  const running = job.phase === 'running';

  useEffect(() => { void refreshResumable().catch(() => {}); }, []);

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    multiple: false,
    disabled: running || !ready,
    onDropRejected: () => setError('drop.unsupported'),
    onDrop: (files) => {
      const file = files[0];
      if (!file) return;
      if (!isSupportedFile(file.name)) return setError('drop.unsupported');
      setError(null);
      void startJob(file);
    },
  });

  const { stats, outcome } = job;
  const percent = stats && stats.totalChunks ? Math.round((stats.completedChunks / stats.totalChunks) * 100) : 0;
  const logs = job.logs.filter((l) => VISIBLE_EVENTS.has(l.event));

  return (
    <section className="space-y-4 rounded-lg border p-4">
      <h2 className="font-medium">{t('title')}</h2>

      {!ready && <p className="text-sm text-amber-700">{t('needConnection')}</p>}

      <div className="grid grid-cols-2 gap-3">
        {(['sourceLanguage', 'targetLanguage'] as const).map((field) => (
          <label key={field} className="block text-sm">
            {t(field === 'sourceLanguage' ? 'source' : 'target')}
            <input
              list="language-list"
              disabled={running}
              className="mt-1 block w-full rounded border px-2 py-1"
              value={options[field]}
              onChange={(e) => options.set({ [field]: e.target.value })}
            />
          </label>
        ))}
        <datalist id="language-list">{LANGUAGES.map((l) => <option key={l} value={l} />)}</datalist>
      </div>

      <details className="text-sm">
        <summary className="cursor-pointer">{t('options')}</summary>
        <div className="mt-2 space-y-2">
          <label className="flex items-center gap-2">
            <input type="checkbox" disabled={running} checked={options.bilingual} onChange={(e) => options.set({ bilingual: e.target.checked })} />
            {t('bilingual')}
          </label>
          <label className="block">
            {t('maxTokens')}
            <input type="number" min={50} max={4000} disabled={running} className="mt-1 block w-32 rounded border px-2 py-1"
              value={options.maxTokensPerChunk}
              onChange={(e) => options.set({ maxTokensPerChunk: Math.max(50, Number(e.target.value) || 450) })} />
          </label>
          <label className="block">
            {t('parallel')}
            <input type="number" min={1} max={16} disabled={running} className="mt-1 block w-32 rounded border px-2 py-1"
              value={options.parallelWorkers}
              onChange={(e) => options.set({ parallelWorkers: Math.min(16, Math.max(1, Number(e.target.value) || 1)) })} />
          </label>
        </div>
      </details>

      {!running && job.phase !== 'finished' && (
        <div
          {...getRootProps()}
          className={`cursor-pointer rounded-lg border-2 border-dashed p-8 text-center text-sm ${isDragActive ? 'border-black' : 'border-gray-300'} ${ready ? '' : 'opacity-50'}`}
        >
          <input {...getInputProps({ accept: SUPPORTED_EXTENSIONS.join(',') })} />
          {isDragActive ? t('drop.active') : t('drop.hint')}
        </div>
      )}
      {error && <p role="alert" className="text-sm text-red-700">{t(error)}</p>}

      {(running || job.phase === 'finished') && (
        <div className="space-y-2" aria-live="polite">
          {running && <p className="text-sm">{t('status.running', { name: job.fileName })}</p>}
          {stats && (
            <>
              <div className="h-2 w-full overflow-hidden rounded bg-gray-200" role="progressbar" aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100}>
                <div className="h-full bg-black transition-all" style={{ width: `${percent}%` }} />
              </div>
              <p className="text-xs text-gray-600">
                {t('progress', { done: stats.completedChunks, total: stats.totalChunks })}
                {stats.failedChunks > 0 && ` · ${t('failed', { count: stats.failedChunks })}`}
              </p>
            </>
          )}

          {running && (
            <button className="rounded border px-3 py-1 text-sm disabled:opacity-50" disabled={job.stopRequested} onClick={stopJob}>
              {job.stopRequested ? t('stopping') : t('stop')}
            </button>
          )}

          {outcome && (
            <p role="status" className={`text-sm ${outcome.status === 'failed' ? 'text-red-700' : ''}`}>
              {outcome.status === 'completed' && t('status.completed')}
              {outcome.status === 'partial' && t('status.partial', { count: outcome.stats.failedChunks })}
              {outcome.status === 'paused' && t(outcome.reason === 'rate_limit' ? 'status.pausedRateLimit' : 'status.pausedInterrupted')}
              {outcome.status === 'failed' && (
                <>
                  {t('status.failed')} {t(`status.reason.${outcome.error}`, { defaultValue: '' })}
                  {!i18n.exists(`translate:status.reason.${outcome.error}`) && (
                    <code className="mt-1 block break-words text-xs text-gray-600">{outcome.error}</code>
                  )}
                </>
              )}
            </p>
          )}

          {job.phase === 'finished' && (
            <div className="flex gap-2">
              {job.output && (
                <button className="rounded bg-black px-3 py-1 text-sm text-white" onClick={() => saveAs(job.output!.blob, job.output!.fileName)}>
                  {t('download')}
                </button>
              )}
              <button className="rounded border px-3 py-1 text-sm" onClick={resetJob}>{t('another')}</button>
            </div>
          )}
        </div>
      )}

      {logs.length > 0 && (
        <details className="text-xs" open={running}>
          <summary className="cursor-pointer text-sm">{t('log.title')}</summary>
          <ul className="mt-2 max-h-40 space-y-1 overflow-auto">
            {logs.map((l) => (
              <li key={l.id}>
                {t(`log.${l.event}`)}
                {l.event === 'llm_request_failed' && <span className="text-gray-500"> — {l.detail}</span>}
              </li>
            ))}
          </ul>
        </details>
      )}

      {!running && job.resumable.length > 0 && (
        <div className="space-y-2 border-t pt-3">
          <h3 className="text-sm font-medium">{t('resume.title')}</h3>
          <ul className="space-y-2">
            {job.resumable.map((r) => (
              <li key={r.id} className="flex items-center justify-between gap-2 text-sm">
                <span className="truncate">
                  {r.fileName} <span className="text-gray-500">({t(`resume.state.${r.status}`)})</span>
                </span>
                <span className="flex shrink-0 gap-2">
                  <button className="rounded bg-black px-2 py-1 text-white disabled:opacity-50" disabled={!ready} onClick={() => void resumeJob(r.id)}>
                    {t('resume.action')}
                  </button>
                  <button className="rounded border px-2 py-1" onClick={() => void discardJob(r.id)}>{t('resume.discard')}</button>
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
