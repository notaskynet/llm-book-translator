// Port of src/core/glossary/inflection.py: the target languages whose case/number inflection
// changes the written form of a term, so a glossary's citation form is rarely the form
// that appears in a sentence.

import { normalizeLangKey } from '../prompts/langKey';

const INFLECTED_TARGET_LANGUAGES = new Set([
  'russian', 'ukrainian', 'belarusian', 'polish', 'czech', 'slovak', 'slovenian', 'croatian', 'serbian',
  'bosnian', 'german', 'greek', 'latvian', 'lithuanian', 'estonian', 'finnish', 'hungarian', 'turkish',
  'romanian', 'icelandic', 'georgian', 'armenian', 'hindi', 'latin',
]);

export function targetLanguageIsInflected(targetLanguage: string): boolean {
  return Boolean(targetLanguage) && INFLECTED_TARGET_LANGUAGES.has(normalizeLangKey(targetLanguage));
}
