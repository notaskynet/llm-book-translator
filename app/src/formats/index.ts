import { SrtAdapter } from './srt';
import { TxtAdapter } from './txt';
import type { AdapterConfig, FormatAdapter } from './types';

export const SUPPORTED_EXTENSIONS = ['.txt', '.srt'] as const;

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
    default:
      throw new Error(`Unsupported file type: ${fileName}`);
  }
}

/** `book.txt` -> `book (French).txt` */
export function outputFileName(fileName: string, targetLanguage: string): string {
  const ext = fileExtension(fileName);
  const base = ext ? fileName.slice(0, -ext.length) : fileName;
  return `${base} (${targetLanguage})${ext}`;
}
