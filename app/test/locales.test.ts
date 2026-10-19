import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LOCALES, NAMESPACES } from '../src/i18n';

const load = (lng: string, ns: string): Record<string, unknown> =>
  JSON.parse(readFileSync(resolve(process.cwd(), `public/locales/${lng}/${ns}.json`), 'utf8'));

function flatten(obj: Record<string, unknown>, prefix = ''): Record<string, string> {
  return Object.entries(obj).reduce<Record<string, string>>((acc, [k, v]) => {
    const key = prefix ? `${prefix}.${k}` : k;
    return typeof v === 'object' && v !== null ? { ...acc, ...flatten(v as Record<string, unknown>, key) } : { ...acc, [key]: String(v) };
  }, {});
}

const placeholders = (s: string) => (s.match(/{{\s*\w+\s*}}/g) ?? []).sort();

// Plural variants differ per language (Russian has four): a literal "1" in English may be
// "{{count}}" in another language, so only the other placeholders are compared.
const isPlural = (key: string) => /_(zero|one|two|few|many|other)$/.test(key);
const comparable = (key: string, s: string) => placeholders(s).filter((p) => !(isPlural(key) && /count/.test(p)));

describe('locale files', () => {
  for (const ns of NAMESPACES) {
    describe(ns, () => {
      const en = flatten(load('en', ns));
      const keys = Object.keys(en);

      for (const lng of LOCALES.filter((l) => l !== 'en')) {
        it(`${lng} has every English key with the same placeholders`, () => {
          const other = flatten(load(lng, ns));
          for (const key of keys) {
            expect(other[key], `${lng}/${ns}:${key}`).toBeTruthy();
            expect(comparable(key, other[key]), `${lng}/${ns}:${key}`).toEqual(comparable(key, en[key]));
          }
        });
      }
    });
  }
});
