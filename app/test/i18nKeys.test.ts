import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// Every literal translation key used by the UI must exist in the English locale file, or the
// user would see the raw key. Keys built at runtime (template strings) are covered by the
// locale parity test instead.

const root = process.cwd();
const load = (ns: string): Record<string, unknown> => {
  try {
    return JSON.parse(readFileSync(resolve(root, `public/locales/en/${ns}.json`), 'utf8'));
  } catch {
    return {};
  }
};

function has(obj: Record<string, unknown>, key: string): boolean {
  if (key in obj) return true;
  let cur: unknown = obj;
  for (const part of key.split('.')) {
    if (typeof cur !== 'object' || cur === null || !(part in cur)) return false;
    cur = (cur as Record<string, unknown>)[part];
  }
  return true;
}

// Plural keys are stored as key_one / key_other.
const exists = (ns: string, key: string) => has(load(ns), key) || has(load(ns), `${key}_one`) || has(load(ns), `${key}_other`);

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? sourceFiles(join(dir, e.name)) : /\.tsx?$/.test(e.name) ? [join(dir, e.name)] : [],
  );
}

describe('translation keys used in the UI', () => {
  for (const file of sourceFiles(resolve(root, 'src/ui')).concat(resolve(root, 'src/App.tsx'))) {
    const source = readFileSync(file, 'utf8');
    // `const { t, i18n } = useTranslation('translate')` and `const { t: tc } = useTranslation('common')`
    const aliases = [...source.matchAll(/const \{ t(?:: (\w+))?[^}]*\} = useTranslation\('(\w+)'\)/g)].map((m) => ({ name: m[1] ?? 't', ns: m[2] }));
    const defaultNs = source.includes('useTranslation()') ? 'common' : null;
    if (!aliases.length && !defaultNs) continue;

    it(file.replace(`${root}/`, ''), () => {
      const missing: string[] = [];
      for (const { name, ns } of aliases) {
        for (const m of source.matchAll(new RegExp(`(?<![\\w.])${name}\\('([\\w.:]+)'`, 'g'))) {
          const [keyNs, key] = m[1].includes(':') ? m[1].split(':') : [ns, m[1]];
          if (!exists(keyNs, key)) missing.push(`${keyNs}:${key}`);
        }
      }
      expect(missing).toEqual([]);
    });
  }
});
