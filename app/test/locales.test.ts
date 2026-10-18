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

// `common` also holds strings of the legacy UI that the app no longer uses; only the keys
// the app reads are held to parity.
const REQUIRED_COMMON_KEYS = ['language'];

describe('locale files', () => {
  for (const ns of NAMESPACES) {
    describe(ns, () => {
      const en = flatten(load('en', ns));
      const keys = ns === 'common' ? REQUIRED_COMMON_KEYS : Object.keys(en);

      for (const lng of LOCALES.filter((l) => l !== 'en')) {
        it(`${lng} has every English key with the same placeholders`, () => {
          const other = flatten(load(lng, ns));
          for (const key of keys) {
            expect(other[key], `${lng}/${ns}:${key}`).toBeTruthy();
            expect(placeholders(other[key]), `${lng}/${ns}:${key}`).toEqual(placeholders(en[key]));
          }
        });
      }
    });
  }
});
