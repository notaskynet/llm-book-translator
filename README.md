# Book Translator (BYOK)

Translate books, subtitles and documents with any OpenAI-compatible LLM, entirely in your browser.
Enter a base URL, an API key and a model, drop a file, and download the translation.

There is no backend: the app is a static site, and your browser talks to the LLM provider directly.
Your key never touches a server of ours.

This is a TypeScript rewrite of [TranslateBooksWithLLM](https://github.com/hydropix/TranslateBooksWithLLMs).
The Python original is the reference for the translation flow, the prompts and the locales; the last
commit that still contains it is `ff1cb51`.

## Features

- **Formats:** EPUB, DOCX, SRT, TXT and PDF (text layer only; delivered as `.txt`).
  - EPUB and DOCX keep their structure: tags, styles, pictures and tables survive, and DOCX is edited in place.
  - SRT keeps its timecodes.
- **Any OpenAI-compatible API:** OpenAI, OpenRouter, Groq, DeepSeek, Mistral, Gemini's compatibility endpoint or your own URL.
  The provider must allow browser (CORS) requests.
- **Resumable:** progress is checkpointed in IndexedDB; close the tab, come back, and continue where you stopped.
- **Styles and instructions:** reusable writing-style presets, hand-written or extracted from sample books by the LLM.
- **Glossaries:** per-term translations (with CSV import and export) and LLM-assisted discovery of recurring names.
- **Refine:** an optional second pass that polishes a finished translation, or an already translated file.
- **Sample & Compare:** run representative excerpts through several models, styles or glossaries and diff the results.
- **Bilingual output**, parallel requests, API key rotation on rate limits, and a UI in 7 languages
  (English, French, Spanish, German, Chinese, Japanese, Korean).

Not included: text-to-speech, local providers such as Ollama, OCR for scanned PDFs.

## Privacy and your API key

The key is kept in `sessionStorage` and disappears when the tab closes. An opt-in "remember" option stores
it in `localStorage` on this device instead. It is never written into a job, a checkpoint or an export.
The page loads no third-party scripts.

## Development

```bash
cd app
npm ci
npm run dev          # http://localhost:5173 ; add ?mock=1 to use the built-in fake LLM
npm test             # unit tests (Vitest, LLM mocked with msw)
npm run test:e2e     # browser tests (Playwright + Chromium, LLM mocked with page.route)
npm run build
```

Nothing in the test suites calls a real provider.

## Deployment

`.github/workflows/pages.yml` tests and builds the app, then publishes it to GitHub Pages on every push to `main`.
Enable it once under **Settings -> Pages -> Source: GitHub Actions**.

## License

AGPL-3.0, inherited from the original project. See [LICENSE](LICENSE).
