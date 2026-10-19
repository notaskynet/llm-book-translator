import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { buildChunkGlossaryBlock } from '@/glossary/chunkBlock';
import { filterGlossary } from '@/glossary/filter';
import { DEFAULT_GLOSSARY_CONFIG, termsMap, termsMetadata, type Glossary } from '@/glossary/models';
import { useTranslationOptions } from '@/store/translation';
import { Modal } from './Modal';

/** Shows which terms a pasted sample would match and the block that would be sent to the model. */
export function GlossaryPreviewDialog({ glossary, onClose }: { glossary: Glossary; onClose: () => void }) {
  const { t } = useTranslation('glossary');
  const { targetLanguage } = useTranslationOptions();
  const [sample, setSample] = useState('');
  const [result, setResult] = useState<{ block: string; matched: number; capped: boolean } | null>(null);

  function render() {
    const terms = termsMap(glossary.terms);
    const { terms: matched, capped } = filterGlossary(sample, terms, DEFAULT_GLOSSARY_CONFIG);
    const block = buildChunkGlossaryBlock(sample, { terms, metadata: termsMetadata(glossary.terms) }, { targetLanguage });
    setResult({ block, matched: matched.size, capped });
  }

  return (
    <Modal title={t('preview_modal_title')} onClose={onClose}>
      <div className="space-y-3 text-sm">
        <p>{t('preview_modal_intro')}</p>
        <textarea aria-label={t('preview_input_placeholder')} className="block w-full rounded border px-2 py-1" rows={5} placeholder={t('preview_input_placeholder')} value={sample} onChange={(e) => setSample(e.target.value)} />
        <button className="rounded bg-accent px-3 py-1 text-accent-fg" onClick={render}>{t('preview_render')}</button>
        {result && (
          <>
            <p>
              {t('preview_matched', { matched: result.matched, total: glossary.terms.length })}
              {result.capped && ` ${t('preview_capped')}`}
            </p>
            <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded bg-gray-50 p-2 text-xs">{result.block || t('preview_no_match')}</pre>
          </>
        )}
      </div>
    </Modal>
  );
}
