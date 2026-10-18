import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import HttpBackend from 'i18next-http-backend';
import LanguageDetector from 'i18next-browser-languagedetector';

export const LOCALES = ['en', 'fr', 'es', 'de', 'zh-CN', 'ja', 'ko'] as const;
export const NAMESPACES = ['common', 'connection', 'translate'] as const;

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
