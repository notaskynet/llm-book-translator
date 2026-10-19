import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import HttpBackend from 'i18next-http-backend';
import LanguageDetector from 'i18next-browser-languagedetector';

export const LOCALES = ['en', 'ru', 'fr', 'es', 'de', 'zh-CN', 'ja', 'ko'] as const;

/** Each language in its own name, so it can be found whatever the current UI language is. */
export const LOCALE_NAMES: Record<(typeof LOCALES)[number], string> = {
  en: 'English', ru: 'Русский', fr: 'Français', es: 'Español', de: 'Deutsch', 'zh-CN': '简体中文', ja: '日本語', ko: '한국어',
};
export const NAMESPACES = ['common', 'connection', 'translate', 'style', 'glossary', 'sample'] as const;

void i18n
  .use(HttpBackend)
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    supportedLngs: [...LOCALES],
    fallbackLng: 'en',
    ns: [...NAMESPACES],
    defaultNS: 'common',
    backend: { loadPath: `${import.meta.env.BASE_URL}locales/{{lng}}/{{ns}}.json` },
    interpolation: { escapeValue: false },
    detection: { caches: ['localStorage'], lookupLocalStorage: 'tbl_locale' },
  });

export default i18n;
