// Port of src/core/llm/utils/extraction.py: pulls the translation out of an LLM
// response, ignoring reasoning blocks and tolerating a few common format slips.

import { TRANSLATE_TAG_IN, TRANSLATE_TAG_OUT } from '../config';

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export class TranslationExtractor {
  private readonly regex: RegExp;

  constructor(
    private readonly tagIn: string = TRANSLATE_TAG_IN,
    private readonly tagOut: string = TRANSLATE_TAG_OUT,
  ) {
    this.regex = new RegExp(`${escapeRegExp(tagIn)}([\\s\\S]*?)${escapeRegExp(tagOut)}`);
  }

  extract(response: string | null | undefined): string | null {
    if (!response) return null;

    let text = response.trim();
    text = this.removeThinkBlocks(text);
    text = this.removeMarkdownCodeBlocks(text).trim();

    const startsCorrectly = text.startsWith(this.tagIn);
    const endsCorrectly = text.endsWith(this.tagOut);
    if (startsCorrectly && endsCorrectly) {
      return text.slice(this.tagIn.length, text.length - this.tagOut.length).trim();
    }

    const match = this.regex.exec(text);
    if (match) return match[1].trim();

    // Fuzzy fallback: opening tag present but the closing tag is malformed
    // (e.g. "</TRANATION>"). Accept any closing tag sharing the first 3 letters.
    if (startsCorrectly) {
      const closing = /^<\/(\w+)>/.exec(this.tagOut);
      if (closing) {
        const prefix = closing[1].slice(0, 3);
        const fuzzy = new RegExp(`${escapeRegExp(this.tagIn)}([\\s\\S]*?)</\\w*${escapeRegExp(prefix)}\\w*>`).exec(text);
        if (fuzzy) return fuzzy[1].trim();
      }
    }
    return null;
  }

  /** Drops markdown fences wrapping the whole response (some providers add ```xml ... ```). */
  private removeMarkdownCodeBlocks(response: string): string {
    const match = /^```\w*\s*\n([\s\S]*?)\n```\s*$/.exec(response);
    return match ? match[1] : response;
  }

  private removeThinkBlocks(response: string): string {
    let out = response.replace(/<think>[\s\S]*?<\/think>/gi, '');

    // Orphan closing tag (the opening one was truncated): drop everything up to it,
    // unless the translation tag already opened before it.
    const orphan = /<\/think>/i.exec(out);
    if (orphan) {
      const prefix = out.slice(0, orphan.index + orphan[0].length);
      if (!prefix.toLowerCase().includes(this.tagIn.toLowerCase())) {
        out = out.slice(prefix.length).trimStart();
      }
    }
    return out;
  }
}
