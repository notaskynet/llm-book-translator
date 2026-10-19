import { DocxAdapter } from '../docx/adapter';
import { EpubAdapter } from '../epub/adapter';
import { PdfAdapter } from './pdf';
import { SrtAdapter } from './srt';
import { TxtAdapter } from './txt';
import type { AdapterConfig, FormatAdapter } from './types';

export const SUPPORTED_EXTENSIONS = ['.txt', '.srt', '.epub', '.docx', '.pdf'] as const;

export function fileExtension(fileName: string): string {
  const dot = fileName.lastIndexOf('.');
  return dot === -1 ? '' : fileName.slice(dot).toLowerCase();
}

export function isSupportedFile(fileName: string): boolean {
  return (SUPPORTED_EXTENSIONS as readonly string[]).includes(fileExtension(fileName));
}

export function createAdapter(fileName: string, input: ArrayBuffer, config: AdapterConfig): FormatAdapter {
  switch (fileExtension(fileName)) {
    case '.txt':
      return new TxtAdapter(input, config);
    case '.srt':
      return new SrtAdapter(input, config);
    case '.epub':
      return new EpubAdapter(input, config);
    case '.docx':
      return new DocxAdapter(input, config);
    case '.pdf':
      return new PdfAdapter(input, config);
    default:
      throw new Error(`Unsupported file type: ${fileName}`);
  }
}

/** A PDF is translated as text, so its output is a .txt file. */
const outputExtension = (fileName: string) => {
  const ext = fileExtension(fileName);
  return ext === '.pdf' ? '.txt' : ext;
};

const stem = (fileName: string) => {
  const ext = fileExtension(fileName);
  return ext ? fileName.slice(0, -ext.length) : fileName;
};

/** `book.txt` -> `book (French).txt` */
export function outputFileName(fileName: string, targetLanguage: string): string {
  return `${stem(fileName)} (${targetLanguage})${outputExtension(fileName)}`;
}

const MIME_TYPES: Record<string, string> = {
  '.epub': 'application/epub+zip',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};

export function mimeTypeFor(fileName: string): string {
  return MIME_TYPES[fileExtension(fileName)] ?? 'text/plain;charset=utf-8';
}

/** `book (French).txt` -> `book (French) (refined).txt` */
export function refinedFileName(fileName: string): string {
  return `${stem(fileName)} (refined)${outputExtension(fileName)}`;
}
