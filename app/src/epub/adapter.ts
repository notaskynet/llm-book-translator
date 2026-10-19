// EPUB format adapter. The Python pipeline translates file by file with its own checkpoint
// layer; here every chunk of every spine document is a translation unit, so the generic
// engine provides concurrency, checkpoints and resume. Chunking is deterministic, so a
// resumed job rebuilds the same units from the stored input.

import JSZip from 'jszip';
import { DEFAULT_MAX_TOKENS_PER_CHUNK } from '../config';
import { initTokenizer } from '../chunking/tokenChunker';
import {
  GENERIC_RETRY_INSTRUCTIONS,
  type AdapterConfig,
  type CheckpointChunk,
  type FormatAdapter,
  type TranslationUnit,
  type UnitTranslationContext,
} from '../formats/types';
import { interleaveBilingual, BILINGUAL_ORIGINAL_STYLE, BILINGUAL_TRANSLATION_STYLE } from './bilingual';
import {
  extractBodyHtml, findBody, localName, parseXhtmlDocument, parseXml, replaceBodyContent, serializeDocument, XML_NS,
} from './dom';
import { chunkHtmlWithPlaceholders, type HtmlChunk } from './htmlChunker';
import { getLanguageCode } from './langCodes';
import { restoreToGlobal } from './placeholders';
import { preserveTags, restoreTags } from './tagPreserver';
import { updateNavLabels, updateNcxLabels } from './toc';
import { refineEpubChunk, translateEpubChunk } from './translateUnit';
import { dirname, joinPath, unquote } from './zipUtils';
import { cleanResidualPlaceholders, escapeStrayAngleBrackets } from './xmlText';

const OPF_NS = 'http://www.idpf.org/2007/opf';
const DC_NS = 'http://purl.org/dc/elements/1.1/';
const CONTENT_TYPES = new Set(['application/xhtml+xml', 'text/html']);
const unitIdOf = (fileIndex: number, chunkIndex: number) => `f${fileIndex}_c${chunkIndex}`;

interface EpubFile {
  index: number;
  path: string;
  doc: Document;
  body: Element | null;
  tagMap: Record<string, string>;
  chunks: HtmlChunk[];
}

export class EpubAdapter implements FormatAdapter {
  readonly formatName = 'epub';
  readonly mimeType = 'application/epub+zip';

  private zip!: JSZip;
  private opfPath = '';
  private opfDoc!: Document;
  private files: EpubFile[] = [];
  /** Translated chunks (chunk-local placeholders) by unit id. */
  private translations = new Map<string, string>();

  constructor(
    private readonly input: ArrayBuffer | Uint8Array,
    private readonly config: AdapterConfig = {},
  ) {}

  private log(event: string, message: string) {
    this.config.log?.(event, message);
  }

  private async readText(path: string): Promise<string | null> {
    return (await this.zip.file(path)?.async('string')) ?? null;
  }

  private async findOpfPath(): Promise<string | null> {
    const container = await this.readText('META-INF/container.xml');
    const doc = container ? parseXml(container) : null;
    const fullPath = doc?.getElementsByTagName('rootfile')[0]?.getAttribute('full-path');
    if (fullPath && this.zip.file(fullPath)) return fullPath;
    return Object.keys(this.zip.files).find((name) => name.toLowerCase().endsWith('.opf')) ?? null;
  }

  private spineHrefs(): string[] {
    const manifest = this.opfDoc.getElementsByTagNameNS(OPF_NS, 'manifest')[0];
    const spine = this.opfDoc.getElementsByTagNameNS(OPF_NS, 'spine')[0];
    if (!manifest || !spine) return [];

    const items = new Map<string, Element>();
    for (const item of Array.from(manifest.getElementsByTagNameNS(OPF_NS, 'item'))) {
      const id = item.getAttribute('id');
      if (id) items.set(id, item);
    }
    const hrefs: string[] = [];
    for (const itemref of Array.from(spine.getElementsByTagNameNS(OPF_NS, 'itemref'))) {
      const item = items.get(itemref.getAttribute('idref') ?? '');
      const href = item?.getAttribute('href');
      if (item && href && CONTENT_TYPES.has(item.getAttribute('media-type') ?? '')) hrefs.push(href);
    }
    return hrefs;
  }

  async prepareForTranslation(): Promise<boolean> {
    try {
      await initTokenizer();
      this.zip = await JSZip.loadAsync(this.input);

      const opfPath = await this.findOpfPath();
      const opfText = opfPath ? await this.readText(opfPath) : null;
      const opfDoc = opfText ? parseXml(opfText) : null;
      if (!opfPath || !opfDoc) return false;
      this.opfPath = opfPath;
      this.opfDoc = opfDoc;

      const maxTokens = this.config.maxTokensPerChunk ?? DEFAULT_MAX_TOKENS_PER_CHUNK;
      const opfDir = dirname(opfPath);
      const seen = new Set<string>();
      this.files = [];

      for (const href of this.spineHrefs()) {
        const path = joinPath(opfDir, unquote(href));
        if (seen.has(path)) continue;
        seen.add(path);

        const text = await this.readText(path);
        if (text === null) {
          this.log('epub_file_not_found', `File '${href}' not found, skipped`);
          continue;
        }
        const doc = parseXhtmlDocument(text);
        if (!doc) {
          this.log('epub_xml_error', `Could not parse '${href}', left untranslated`);
          continue;
        }

        const body = findBody(doc);
        let tagMap: Record<string, string> = {};
        let chunks: HtmlChunk[] = [];
        const html = body ? extractBodyHtml(body) : '';
        if (html.trim()) {
          const preserved = preserveTags(html);
          tagMap = preserved.tagMap;
          chunks = chunkHtmlWithPlaceholders(preserved.text, tagMap, maxTokens);
        }
        this.files.push({ index: this.files.length, path, doc, body, tagMap, chunks });
      }
      return true;
    } catch {
      return false;
    }
  }

  getTranslationUnits(): TranslationUnit[] {
    return this.files.flatMap((file) =>
      file.chunks.map((chunk, j) => ({
        unitId: unitIdOf(file.index, j),
        content: chunk.text,
        contextBefore: '',
        contextAfter: '',
        metadata: { file_index: file.index, chunk_index: j, href: file.path },
      })),
    );
  }

  private chunkOf(unit: TranslationUnit): HtmlChunk | undefined {
    return this.files[unit.metadata.file_index as number]?.chunks[unit.metadata.chunk_index as number];
  }

  async translateUnit(unit: TranslationUnit, ctx: UnitTranslationContext): Promise<string | null> {
    const chunk = this.chunkOf(unit);
    if (!chunk) return null;
    return (await translateEpubChunk(chunk, ctx)).text;
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
      const { file_index: fi, chunk_index: ci } = c.chunkData as { file_index?: number; chunk_index?: number };
      if (c.status === 'completed' && c.translatedText != null && fi !== undefined && ci !== undefined) {
        this.translations.set(unitIdOf(fi, ci), c.translatedText);
      }
    }
  }

  async cleanup(): Promise<void> {}

  // --- output ------------------------------------------------------------------------

  private reconstructBodyHtml(file: EpubFile, bilingual: boolean): string {
    const toGlobal = (text: string, chunk: HtmlChunk) => restoreToGlobal(text, chunk.globalIndices);
    const translated = file.chunks
      .map((chunk, j) => toGlobal(this.translations.get(unitIdOf(file.index, j)) ?? chunk.text, chunk))
      .join('');
    // Stray < and > in model output would become phantom elements; real tags live in the tag map.
    const transFull = restoreTags(escapeStrayAngleBrackets(translated), file.tagMap);
    if (!bilingual) return transFull;

    const origFull = restoreTags(escapeStrayAngleBrackets(file.chunks.map((c) => toGlobal(c.text, c)).join('')), file.tagMap);
    return (
      interleaveBilingual(origFull, transFull) ??
      // Lossless fallback when the container structures do not align.
      `<div class="bilingual-original" style="${BILINGUAL_ORIGINAL_STYLE}">${origFull}</div>` +
        `<div class="bilingual-translation" style="${BILINGUAL_TRANSLATION_STYLE}">${transFull}</div>`
    );
  }

  private cleanResidualPlaceholdersIn(doc: Document) {
    const walker = doc.createTreeWalker(doc.documentElement, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const cleaned = cleanResidualPlaceholders(node.nodeValue ?? '');
      if (cleaned !== node.nodeValue) node.nodeValue = cleaned;
    }
  }

  private setLang(doc: Document, code: string): boolean {
    const root = doc.documentElement;
    if (!root || localName(root) !== 'html') return false;
    let changed = false;
    if (root.getAttribute('lang') !== code) { root.setAttribute('lang', code); changed = true; }
    if (root.getAttributeNS(XML_NS, 'lang') !== code) { root.setAttributeNS(XML_NS, 'xml:lang', code); changed = true; }
    return changed;
  }

  private navPath(): string | null {
    const manifest = this.opfDoc.getElementsByTagNameNS(OPF_NS, 'manifest')[0];
    for (const item of Array.from(manifest?.getElementsByTagNameNS(OPF_NS, 'item') ?? [])) {
      if ((item.getAttribute('properties') ?? '').split(/\s+/).includes('nav') && item.getAttribute('href')) {
        return joinPath(dirname(this.opfPath), unquote(item.getAttribute('href')!));
      }
    }
    return null;
  }

  async reconstructOutput({ bilingual = false } = {}): Promise<Uint8Array> {
    const opfDir = dirname(this.opfPath);
    const code = getLanguageCode(this.config.targetLanguage);
    const docsByPath = new Map<string, Document>();

    for (const file of this.files) {
      if (file.body && file.chunks.length) {
        try {
          replaceBodyContent(file.body, this.reconstructBodyHtml(file, bilingual));
          this.cleanResidualPlaceholdersIn(file.doc);
        } catch (err) {
          // Keep the source body rather than lose the file.
          this.log('replace_body_error', `Failed to replace body of '${file.path}': ${String(err)}`);
        }
      }
      docsByPath.set(file.path, file.doc);
    }

    // TOC labels (EPUB2 NCX and EPUB3 nav) follow the translated headings.
    const written = new Set<string>();
    for (const name of Object.keys(this.zip.files)) {
      if (!name.toLowerCase().endsWith('.ncx') || dirname(name) !== opfDir) continue;
      const ncx = parseXml((await this.readText(name)) ?? '');
      if (ncx && updateNcxLabels(ncx, opfDir, docsByPath).updated > 0) this.zip.file(name, serializeDocument(ncx));
    }
    const navPath = this.navPath();
    if (navPath) {
      let navDoc = docsByPath.get(navPath);
      const inSpine = Boolean(navDoc);
      if (!navDoc) navDoc = parseXhtmlDocument((await this.readText(navPath)) ?? '') ?? undefined;
      if (navDoc) {
        updateNavLabels(navDoc, dirname(navPath), docsByPath);
        if (!inSpine) {
          if (code) this.setLang(navDoc, code);
          this.zip.file(navPath, serializeDocument(navDoc));
          written.add(navPath);
        }
      }
    }

    // Spine documents, with the target language on <html>.
    for (const file of this.files) {
      if (code) this.setLang(file.doc, code);
      this.zip.file(file.path, serializeDocument(file.doc));
      written.add(file.path);
    }

    // Any other XHTML file: only the language attributes change.
    if (code) {
      for (const name of Object.keys(this.zip.files)) {
        if (written.has(name) || !/\.(xhtml|html|htm)$/i.test(name)) continue;
        const doc = parseXhtmlDocument((await this.readText(name)) ?? '');
        if (doc && this.setLang(doc, code)) this.zip.file(name, serializeDocument(doc));
      }
    }

    // OPF: dc:language must agree with the XHTML lang attributes.
    const languageEl = this.opfDoc.getElementsByTagNameNS(DC_NS, 'language')[0];
    if (languageEl && code) languageEl.textContent = code;
    this.zip.file(this.opfPath, serializeDocument(this.opfDoc));

    return this.buildArchive();
  }

  /** `mimetype` must be the first entry and stored uncompressed. */
  private async buildArchive(): Promise<Uint8Array> {
    const out = new JSZip();
    out.file('mimetype', 'application/epub+zip', { compression: 'STORE' });
    for (const [name, entry] of Object.entries(this.zip.files)) {
      if (entry.dir || name === 'mimetype') continue;
      out.file(name, await entry.async('uint8array'));
    }
    return out.generateAsync({ type: 'uint8array', compression: 'DEFLATE', mimeType: 'application/epub+zip' });
  }
}
