import { describe, expect, it } from 'vitest';
import reference from './fixtures/python-reference.json';
import {
  generatePostProcessingPrompt, generateRefinementPrompt, generateSubtitleRefinementBlockPrompt,
  type PromptOptions,
} from '../src/prompts/prompts';
import { capChunkText, selectSampleIndices } from '../src/sample/select';
import { cleanTranslatedText } from '../src/text/postProcess';

const camel = (a: Record<string, any>) => ({
  draftTranslation: a.draft_translation,
  previousRefinedContext: a.previous_refined_context,
  targetLanguage: a.target_language,
  hasPlaceholders: a.has_placeholders,
  promptOptions: a.prompt_options as PromptOptions | undefined,
  additionalInstructions: a.additional_instructions,
  glossaryBlock: a.glossary_block,
});

describe('refinement prompts match the Python implementation', () => {
  reference.refine_prompts.forEach((c, i) => {
    it(`refine #${i} ${c.args.target_language} placeholders=${c.args.has_placeholders}`, () => {
      expect(generateRefinementPrompt(camel(c.args))).toEqual({ system: c.system, user: c.user });
    });
  });

  for (const c of reference.subtitle_refine_prompts) {
    it(`subtitle refine ${c.args.target_language}`, () => {
      const a = c.args as Record<string, any>;
      expect(generateSubtitleRefinementBlockPrompt({
        subtitleBlocks: a.subtitle_blocks, previousRefinedBlock: a.previous_refined_block,
        targetLanguage: a.target_language, additionalInstructions: a.additional_instructions, glossaryBlock: a.glossary_block,
      })).toEqual({ system: c.system, user: c.user });
    });
  }

  for (const c of reference.post_processing_prompts) {
    it('post-processing is the refinement prompt', () => {
      const a = c.args as Record<string, any>;
      expect(generatePostProcessingPrompt({
        translatedText: a.translated_text, targetLanguage: a.target_language, additionalInstructions: a.additional_instructions,
        hasPlaceholders: a.has_placeholders, glossaryBlock: a.glossary_block,
      })).toEqual({ system: c.system, user: c.user });
    });
  }
});

describe('cleanTranslatedText matches the Python implementation', () => {
  for (const c of reference.clean_text) {
    it(JSON.stringify(c.text), () => expect(cleanTranslatedText(c.text)).toBe(c.result));
  }
});

describe('sample selection matches the Python implementation', () => {
  for (const c of reference.sample_indices) {
    it(`${c.n} samples from ${c.total} chunks`, () => {
      if ('error' in c) expect(() => selectSampleIndices(c.total, c.n)).toThrow(c.error);
      else expect(selectSampleIndices(c.total, c.n)).toEqual(c.result);
    });
  }

  for (const c of reference.cap_chunk) {
    it(`caps ${JSON.stringify(c.text).slice(0, 30)} at ${c.max}`, () => {
      expect(capChunkText(c.text, c.max)).toEqual([c.result, c.capped]);
    });
  }

  it('rejects a non-positive budget', () => {
    expect(() => capChunkText('x', 0)).toThrow();
  });
});
