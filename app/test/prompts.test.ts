import { describe, expect, it } from 'vitest';
import reference from './fixtures/python-reference.json';
import {
  generatePlaceholderCorrectionPrompt,
  generateSubtitleBlockPrompt,
  generateTranslationPrompt,
  type PromptOptions,
} from '../src/prompts/prompts';

interface Case {
  name: string;
  inputs: Record<string, any>;
  system: string;
  user: string;
}

function run(c: Case) {
  const i = c.inputs;
  switch (i.kind) {
    case 'translation':
      return generateTranslationPrompt({
        mainContent: i.main_content,
        contextBefore: i.context_before,
        contextAfter: i.context_after,
        previousTranslationContext: i.previous_translation_context,
        sourceLanguage: i.source_language,
        targetLanguage: i.target_language,
        hasPlaceholders: i.has_placeholders,
        promptOptions: i.prompt_options as PromptOptions | undefined,
        glossaryBlock: i.glossary_block,
      });
    case 'subtitle':
      return generateSubtitleBlockPrompt({
        subtitleBlocks: i.subtitle_blocks,
        previousTranslationBlock: i.previous_translation_block,
        sourceLanguage: i.source_language,
        targetLanguage: i.target_language,
        customInstructions: i.custom_instructions,
        glossaryBlock: i.glossary_block,
      });
    case 'correction':
      return generatePlaceholderCorrectionPrompt({
        originalText: i.original_text,
        translatedText: i.translated_text,
        specificErrors: i.specific_errors,
        sourceLanguage: i.source_language,
        targetLanguage: i.target_language,
        expectedCount: i.expected_count,
      });
    default:
      throw new Error(`unknown case kind ${i.kind}`);
  }
}

describe('prompts match the Python implementation', () => {
  for (const c of reference.prompts as Case[]) {
    it(c.name, () => {
      const out = run(c);
      expect(out.system).toBe(c.system);
      expect(out.user).toBe(c.user);
    });
  }
});
