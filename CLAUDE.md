# CLAUDE.md

Instructions for Claude Code when working in this repo.

## Project

A static, client-only BYOK book translator (Vite, React, TypeScript) living in `app/`. The user enters an
OpenAI-compatible base URL, API key and model, and the browser talks to the provider directly. There is no
backend. It is a port of the Python project TranslateBooksWithLLM; the last commit that contains the Python
code is `ff1cb51`, and the translation flow, prompts and locales follow it closely.

Layout (all under `app/src`): `llm/` (provider, retries, key pool), `prompts/`, `chunking/`, `formats/`,
`epub/`, `docx/`, `translate/` (generic engine, job controller), `checkpoint/` (IndexedDB), `glossary/`,
`style/`, `sample/`, `documents/`, `ui/`, `store/`.

## Language policy

Everything that lives on GitHub must be written in English: code, identifiers, code comments, commit
messages, PR titles and descriptions, issue text, documentation files, and user-facing strings in the
English locale. Replies to the user in chat may follow the language the user writes in, but any committed
artifact must be English-only (other languages only in the translated locale files).

## Security rules - API keys and secrets

**Absolutely forbidden** to hardcode an API key, token, password, URL containing a secret, or any other
credential in a source file, test, script, comment, doc example or commit message. No exceptions.

- The app never reads keys from files or the environment: the user types them into the UI, and they stay in
  `sessionStorage` (or `localStorage` when the user opts in). Never write a key into a job config, a
  checkpoint, an export or a log.
- Tests use mocked LLMs only (msw in Vitest, `page.route` in Playwright) with inert placeholders such as
  `test-key-not-real`. Never call a real provider from a test or script.
- Examples in docs that illustrate a key format use `YOUR_API_KEY_HERE`, `sk-xxxxxxxx` or `<REDACTED>`.
- Before each commit, if the diff contains something that looks like a key (long base64/hex string, prefix
  `sk-`/`Bearer`/`ghp_`/`AKIA`, or a `key`/`token`/`secret` variable with a real value), stop and alert the user.
- If a key is found in existing code, flag it immediately, recommend revoking it, and remove the literal.

## i18n rules - every user-facing string must be translated

The UI uses `react-i18next`; locales live in `app/public/locales/<lang>/<namespace>.json` for
`en`, `ru`, `fr`, `es`, `de`, `zh-CN`, `ja`, `ko`. Components re-render on language change, so reactivity comes for free
as long as strings go through `t()`.

- Never write raw human text into JSX, `aria-label`, `title`, `placeholder`, `alert()` or error banners. Use
  `const { t } = useTranslation('<namespace>')` and a key.
- Do not cache `t(...)` results in module-scope constants; call it during render.
- A new key goes into all 8 locale files of its namespace in the same commit. English is the source of truth;
  keep every `{{placeholder}}` identical across languages.
- `test/locales.test.ts` (key and placeholder parity) and `test/i18nKeys.test.ts` (every literal `t('key')` in
  `src/ui` exists in `en`) enforce this; keep them green.

## Testing and quality

Run from `app/` before committing:

```bash
npx tsc -b          # types
npm test            # Vitest
npm run test:e2e    # Playwright (Chromium); needs `npx playwright install chromium` once
```

- `test/fixtures/python-reference.json` and the data files in `src/prompts/data` and `src/epub/data` were
  dumped from the Python original and are frozen: parity tests compare against them. Do not edit by hand.
- Browser behaviour (DOMParser, XMLSerializer, JSZip, pdf.js) must be covered by an e2e test when it matters;
  jsdom is not enough.
- A test that cannot fail is worthless: when adding one for a bug or invariant, check it fails without the fix.

## Repository hygiene

No ad-hoc scripts or debug files at the repo root; put scratch work outside the repo. Keep dependencies in
`app/package.json`; prefer an established library over hand-written code.
