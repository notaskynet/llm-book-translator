import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { library } from '@/checkpoint';
import type { StyleMode } from '@/prompts/prompts';
import { slugifyPresetName, type Preset } from '@/presets/format';
import { assembleInstructions, type StyleRule } from '@/style/assembler';
import { ALLOWED_DIMENSIONS } from '@/style/dimensions';
import { Modal } from './Modal';

/** Edits one preset. The two prompt blocks follow the rules until the user edits them by hand. */
export function StyleEditor({ preset, onClose, onSaved }: { preset: Preset | null; onClose: () => void; onSaved: () => void }) {
  const { t } = useTranslation('style');
  const { t: tc } = useTranslation('common');
  const isNew = preset === null;

  const [name, setName] = useState(preset?.name ?? '');
  const [description, setDescription] = useState(preset?.description ?? '');
  const [mode, setMode] = useState<StyleMode>(preset?.mode ?? 'source');
  const [context, setContext] = useState(preset?.context ?? '');
  const [rules, setRules] = useState<StyleRule[]>(preset?.rules ?? []);
  const [translation, setTranslation] = useState(preset?.translation ?? '');
  const [refinement, setRefinement] = useState(preset?.refinement ?? '');
  const [manual, setManual] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const assembled = useMemo(() => assembleInstructions(mode, rules, context), [mode, rules, context]);
  // A preset opened from storage keeps its text until its rules change, so hand edits are not lost.
  const [followRules, setFollowRules] = useState(isNew);
  const shownTranslation = followRules && !manual ? (assembled.translation ?? '') : translation;
  const shownRefinement = followRules && !manual ? (assembled.refinement ?? '') : refinement;

  const changeRules = (next: StyleRule[]) => { setRules(next); setFollowRules(true); };
  const reassemble = () => {
    setTranslation(assembled.translation ?? '');
    setRefinement(assembled.refinement ?? '');
    setManual(false);
    setFollowRules(true);
  };

  async function save() {
    try {
      slugifyPresetName(name);
    } catch {
      setError(t('preset_name_label'));
      return;
    }
    try {
      await library.savePreset({
        id: preset?.id, name: name.trim(), description, mode, context,
        sourceFiles: preset?.sourceFiles ?? [], generatedAt: preset?.generatedAt ?? null,
        rules: rules.filter((r) => r.instruction.trim()),
        translation: shownTranslation.trim() || null, refinement: shownRefinement.trim() || null,
      });
      onSaved();
      onClose();
    } catch (err) {
      setError(t('save_failed', { error: err instanceof Error ? err.message : String(err) }));
    }
  }

  const updateRule = (i: number, patch: Partial<StyleRule>) => changeRules(rules.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  return (
    <Modal title={t('editor_title')} onClose={onClose}>
      <div className="space-y-3 text-sm">
        <label className="block">
          {t('preset_name_label')}
          <input className="mt-1 block w-full rounded border px-2 py-1" value={name} disabled={!isNew} onChange={(e) => setName(e.target.value)} />
        </label>
        <label className="block">
          {t('editor_description_label')}
          <input className="mt-1 block w-full rounded border px-2 py-1" value={description} onChange={(e) => setDescription(e.target.value)} />
        </label>
        <label className="block">
          {t('mode_label')}
          <select className="mt-1 block w-full rounded border px-2 py-1" value={mode} onChange={(e) => { setMode(e.target.value as StyleMode); setFollowRules(true); }}>
            <option value="source">{t('mode_source')}</option>
            <option value="model">{t('mode_model')}</option>
          </select>
        </label>
        <label className="block">
          {t('context_label')}
          <textarea className="mt-1 block w-full rounded border px-2 py-1" rows={2} placeholder={t('context_placeholder')} value={context} onChange={(e) => { setContext(e.target.value); setFollowRules(true); }} />
        </label>

        <fieldset className="space-y-2">
          <legend className="font-medium">{t('editor_rules_label')}</legend>
          {rules.map((rule, i) => (
            <div key={i} className="flex gap-2">
              <select aria-label={t('mode_column')} className="rounded border px-1 py-1" value={rule.dimension} onChange={(e) => updateRule(i, { dimension: e.target.value })}>
                {ALLOWED_DIMENSIONS.map((d) => <option key={d} value={d}>{t(`dimension_${d}`)}</option>)}
              </select>
              <input aria-label={t('editor_rules_label')} className="min-w-0 flex-1 rounded border px-2 py-1" value={rule.instruction} onChange={(e) => updateRule(i, { instruction: e.target.value })} />
              <button className="rounded border px-2" onClick={() => changeRules(rules.filter((_, j) => j !== i))}>{t('remove_rule')}</button>
            </div>
          ))}
          <button className="rounded border px-2 py-1" onClick={() => changeRules([...rules, { dimension: 'other', instruction: '' }])}>{t('add_rule')}</button>
        </fieldset>

        {manual && <p className="text-amber-700">{t('manual_edits_badge')}: {t('manual_edits_warning')}</p>}
        <label className="block">
          {t('translation_block_label')}
          <textarea className="mt-1 block w-full rounded border px-2 py-1 font-mono text-xs" rows={6} value={shownTranslation} onChange={(e) => { setTranslation(e.target.value); setRefinement(shownRefinement); setManual(true); setFollowRules(false); }} />
        </label>
        <label className="block">
          {t('refinement_block_label')}
          <textarea className="mt-1 block w-full rounded border px-2 py-1 font-mono text-xs" rows={4} value={shownRefinement} onChange={(e) => { setRefinement(e.target.value); setTranslation(shownTranslation); setManual(true); setFollowRules(false); }} />
        </label>
        <button className="rounded border px-2 py-1" onClick={reassemble}>{t('reassemble')}</button>

        {error && <p role="alert" className="text-red-700">{error}</p>}
        <div className="flex justify-end gap-2">
          <button className="rounded border px-3 py-1" onClick={onClose}>{tc('cancel')}</button>
          <button className="rounded bg-black px-3 py-1 text-white" onClick={() => void save()}>{tc('save')}</button>
        </div>
      </div>
    </Modal>
  );
}
