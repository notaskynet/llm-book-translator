// DOCX format adapter.
//
// The Python pipeline converts DOCX to HTML (mammoth), translates it like an EPUB chapter and
// rebuilds a fresh document with python-docx, which loses styles, fonts and layout. Here the
// original package is edited in place instead: each paragraph's text runs are exposed to the
// model as `<s>` spans (which the tag preserver turns into `[idN]` placeholders, as for EPUB)
// and the translated text is written back into the same runs, so every run property, image,
// field, table and section setting of the source survives.

import JSZip from 'jszip';
import { DEFAULT_MAX_TOKENS_PER_CHUNK } from '../config';
import { initTokenizer } from '../chunking/tokenChunker';
import { parseFragment, parseXml, serializeDocument } from '../epub/dom';
import { chunkHtmlWithPlaceholders, type HtmlChunk } from '../epub/htmlChunker';
import { restoreToGlobal } from '../epub/placeholders';
import { preserveTags, restoreTags } from '../epub/tagPreserver';
import { refineEpubChunk, translateEpubChunk } from '../epub/translateUnit';
import { escapeStrayAngleBrackets } from '../epub/xmlText';
import {
  GENERIC_RETRY_INSTRUCTIONS,
  type AdapterConfig,
  type CheckpointChunk,
  type FormatAdapter,
  type TranslationUnit,
  type UnitTranslationContext,
} from '../formats/types';

export const W_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const XML_NS = 'http://www.w3.org/XML/1998/namespace';
const MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

/** Packages holding body text; headers and footers are left as they are. */
const TEXT_PARTS = ['word/document.xml', 'word/footnotes.xml', 'word/endnotes.xml'];

/** Parts of a bilingual copy that must not be duplicated (ids would collide). */
const NOT_CLONED = new Set(['bookmarkStart', 'bookmarkEnd', 'drawing', 'pict', 'object', 'commentRangeStart', 'commentRangeEnd']);

const unitIdOf = (chunkIndex: number) => `c${chunkIndex}`;
const escapeText = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const wChildren = (el: Element, name: string) =>
  Array.from(el.childNodes).filter((n): n is Element => n.nodeType === 1 && (n as Element).localName === name && (n as Element).namespaceURI === W_NS);

/** A run of consecutive text runs sharing the same formatting; it reads as one span. */
interface Group {
  runs: Element[];
  text: string;
}

interface ParagraphModel {
  el: Element;
  groups: Group[];
}

const nearestParagraph = (node: Element): Element | null => {
  for (let p = node.parentNode as Element | null; p; p = p.parentNode as Element | null) {
    if (p.localName === 'p' && p.namespaceURI === W_NS) return p;
  }
  return null;
};

const insideFallback = (node: Element): boolean => {
  for (let p = node.parentNode as Element | null; p && p.nodeType === 1; p = p.parentNode as Element | null) {
    if (p.localName === 'Fallback') return true;
  }
  return false;
};

const runText = (run: Element) => wChildren(run, 't').map((t) => t.textContent ?? '').join('');

/** Splits a paragraph's runs into spans of formatting-identical text runs. */
function paragraphModel(p: Element): ParagraphModel {
  const runs = Array.from(p.getElementsByTagNameNS(W_NS, 'r')).filter((r) => nearestParagraph(r) === p && !insideFallback(r));
  const groups: Group[] = [];
  let open: { key: string; group: Group } | null = null;

  for (const run of runs) {
    const content = Array.from(run.childNodes).filter((n) => n.nodeType === 1 && (n as Element).localName !== 'rPr') as Element[];
    const texts = content.filter((n) => n.localName === 't');
    if (!texts.length) { open = null; continue; } // tab, break, picture, field code...: stays where it is

    const pure = texts.length === content.length;
    const key = new XMLSerializer().serializeToString(wChildren(run, 'rPr')[0] ?? run.ownerDocument.createElement('none'));
    if (pure && open && open.key === key) {
      open.group.runs.push(run);
      open.group.text += runText(run);
    } else {
      const group = { runs: [run], text: runText(run) };
      groups.push(group);
      open = pure ? { key, group } : null;
    }
  }
  return { el: p, groups };
}

const hasText = (g: Group) => /\S/.test(g.text);

function writeGroup(group: Group, text: string) {
  const ts = group.runs.flatMap((run) => wChildren(run, 't'));
  const [head, ...tail] = ts;
  for (const t of tail) t.parentNode?.removeChild(t);
  head.textContent = text;
  head.setAttributeNS(XML_NS, 'xml:space', 'preserve');
}

/** Writes translated spans into a paragraph's runs; falls back to one blob if spans were lost. */
function applyTranslation(model: ParagraphModel, spans: Map<number, string>, whole: string) {
  const { groups } = model;
  if (groups.every((g, i) => !hasText(g) || spans.has(i))) {
    groups.forEach((g, i) => { if (hasText(g)) writeGroup(g, spans.get(i) ?? g.text); });
    return;
  }
  // The model dropped some placeholders: keep the text, lose only the run formatting.
  const translatable = groups.filter(hasText);
  translatable.forEach((g, i) => writeGroup(g, i === 0 ? whole : ''));
}

interface Part {
  path: string;
  doc: Document;
  paragraphs: ParagraphModel[];
}

export class DocxAdapter implements FormatAdapter {
  readonly formatName = 'docx';
  readonly mimeType = MIME;

  private zip!: JSZip;
  private parts: Part[] = [];
  private models: ParagraphModel[] = [];
  private tagMap: Record<string, string> = {};
  private chunks: HtmlChunk[] = [];
  private translations = new Map<string, string>();

  constructor(
    private readonly input: ArrayBuffer | Uint8Array,
    private readonly config: AdapterConfig = {},
  ) {}

  private log(event: string, message: string) {
    this.config.log?.(event, message);
  }

  async prepareForTranslation(): Promise<boolean> {
    try {
      await initTokenizer();
      this.zip = await JSZip.loadAsync(this.input);
      if (!this.zip.file('word/document.xml')) return false;

      this.parts = [];
      this.models = [];
      const lines: string[] = [];
      for (const path of TEXT_PARTS) {
        const text = await this.zip.file(path)?.async('string');
        const doc = text ? parseXml(text) : null;
        if (!doc) {
          if (path === 'word/document.xml') return false;
          continue;
        }
        const paragraphs = Array.from(doc.getElementsByTagNameNS(W_NS, 'p'))
          .filter((p) => !insideFallback(p))
          .map(paragraphModel);
        for (const model of paragraphs) {
          if (!model.groups.some(hasText)) continue;
          const index = this.models.push(model) - 1;
          lines.push(
            `<p data-i="${index}">` +
              model.groups.map((g, k) => `<s data-i="${k}">${escapeText(g.text)}</s>`).join('') +
              '</p>',
          );
        }
        this.parts.push({ path, doc, paragraphs });
      }

      this.chunks = [];
      this.tagMap = {};
      if (lines.length) {
        const preserved = preserveTags(lines.join('\n'));
        this.tagMap = preserved.tagMap;
        this.chunks = chunkHtmlWithPlaceholders(preserved.text, this.tagMap, this.config.maxTokensPerChunk ?? DEFAULT_MAX_TOKENS_PER_CHUNK);
      }
      return true;
    } catch {
      return false;
    }
  }

  getTranslationUnits(): TranslationUnit[] {
    return this.chunks.map((chunk, j) => ({
      unitId: unitIdOf(j),
      content: chunk.text,
      contextBefore: '',
      contextAfter: '',
      metadata: { chunk_index: j },
    }));
  }

  private chunkOf(unit: TranslationUnit): HtmlChunk | undefined {
    return this.chunks[unit.metadata.chunk_index as number];
  }

  async translateUnit(unit: TranslationUnit, ctx: UnitTranslationContext): Promise<string | null> {
    const chunk = this.chunkOf(unit);
    return chunk ? (await translateEpubChunk(chunk, ctx)).text : null;
  }

  async refineUnit(unit: TranslationUnit, ctx: UnitTranslationContext): Promise<string | null> {
    const chunk = this.chunkOf(unit);
    return chunk ? refineEpubChunk(chunk, ctx) : null;
  }

  /** Placeholder validation happens inside translateUnit, with its own fallback chain. */
  validateUnitTranslation(): string | null {
    return null;
  }

  getValidationRetryInstructions(feedback: string): string {
    return GENERIC_RETRY_INSTRUCTIONS(feedback);
  }

  async saveUnitTranslation(unitId: string, translated: string): Promise<boolean> {
    this.translations.set(unitId, translated);
    return true;
  }

  async resumeFromCheckpoint(chunks: CheckpointChunk[]): Promise<void> {
    for (const c of chunks) {
      const index = (c.chunkData as { chunk_index?: number }).chunk_index;
      if (c.status === 'completed' && c.translatedText != null && index !== undefined) {
        this.translations.set(unitIdOf(index), c.translatedText);
      }
    }
  }

  async cleanup(): Promise<void> {}

  // --- output ------------------------------------------------------------------------

  /** The translated paragraphs, as the `<p data-i>` elements the model returned. */
  private translatedParagraphs(): Map<number, { spans: Map<number, string>; whole: string }> {
    const joined = this.chunks
      .map((chunk, j) => restoreToGlobal(this.translations.get(unitIdOf(j)) ?? chunk.text, chunk.globalIndices))
      .join('');
    const html = restoreTags(escapeStrayAngleBrackets(joined), this.tagMap);

    const host = this.parts[0].doc;
    const nodes = parseFragment(html, host);
    const found = new Map<number, { spans: Map<number, string>; whole: string }>();
    const visit = (el: Element) => {
      const name = el.localName.toLowerCase();
      if (name === 'p' && el.hasAttribute('data-i')) {
        const spans = new Map<number, string>();
        for (const s of Array.from(el.getElementsByTagName('s'))) {
          const k = Number.parseInt(s.getAttribute('data-i') ?? '', 10);
          if (!Number.isNaN(k)) spans.set(k, s.textContent ?? '');
        }
        found.set(Number.parseInt(el.getAttribute('data-i')!, 10), { spans, whole: el.textContent ?? '' });
        return;
      }
      for (const child of Array.from(el.children)) visit(child);
    };
    for (const node of nodes) if (node.nodeType === 1) visit(node as Element);
    return found;
  }

  async reconstructOutput({ bilingual = false } = {}): Promise<Uint8Array> {
    const translated = this.chunks.length ? this.translatedParagraphs() : new Map();

    this.models.forEach((model, index) => {
      const result = translated.get(index);
      if (!result) return; // lost in transit: the source paragraph stays
      let copy: ParagraphModel | null = null;
      if (bilingual) {
        const clone = model.el.cloneNode(true) as Element;
        for (const el of Array.from(clone.getElementsByTagName('*'))) {
          if (el.namespaceURI === W_NS && NOT_CLONED.has(el.localName)) el.parentNode?.removeChild(el);
        }
        copy = paragraphModel(clone);
      }
      applyTranslation(copy ?? model, result.spans, result.whole);
      if (copy) model.el.parentNode?.insertBefore(copy.el, model.el.nextSibling);
    });

    for (const part of this.parts) this.zip.file(part.path, serializeDocument(part.doc));
    return this.zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE', mimeType: MIME });
  }
}
