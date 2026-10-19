// Builds the text sample sent to the model for NER and style extraction
// (the sampling flow of src/api/blueprints/custom_instruction_routes.py and glossary_routes.py).

import { extractFullText, takeDistributedSamples, FULL_TEXT_CAP, SUPPORTED_EXTS } from './sampler';

export const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

export interface SampleFile {
  name: string;
  size: number;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export interface SampleMeta {
  fileName: string;
  sampleChars: number;
  sampleCount: number;
  fullTextChars: number;
}

export type SampleNote =
  | { kind: 'unreadable'; fileName: string }
  | { kind: 'short'; fileName: string; chars: number }
  | { kind: 'reduced'; fileName: string; from: number; to: number };

export interface SampleResult {
  text: string;
  files: SampleMeta[];
  notes: SampleNote[];
}

export class UnsupportedFileError extends Error {
  constructor(readonly extension: string) {
    super(`Unsupported file type ${extension}`);
  }
}

export const fileExtension = (name: string) => {
  const dot = name.lastIndexOf('.');
  return dot === -1 ? '' : name.slice(dot).toLowerCase();
};

/**
 * Distributed excerpts from one or more files. The budget is split evenly between the files
 * (the first gets the remainder); each file contributes `sampleCount / files` excerpts.
 */
export async function sampleFiles(
  files: SampleFile[],
  options: { maxChars: number; sampleCount: number; minSampleSize: number },
): Promise<SampleResult> {
  for (const f of files) {
    if (!SUPPORTED_EXTS.includes(fileExtension(f.name))) throw new UnsupportedFileError(fileExtension(f.name));
  }
  const perFileBudget = Math.floor(options.maxChars / files.length);
  const remainder = options.maxChars - perFileBudget * files.length;
  const perFileSamples = Math.max(1, Math.floor(options.sampleCount / files.length));

  const blocks: string[] = [];
  const meta: SampleMeta[] = [];
  const notes: SampleNote[] = [];

  for (const [index, file] of files.entries()) {
    const budget = perFileBudget + (index === 0 ? remainder : 0);
    const full = await extractFullText(file, FULL_TEXT_CAP);
    if (!full) { notes.push({ kind: 'unreadable', fileName: file.name }); continue; }

    const [joined, effective] = takeDistributedSamples(full, budget, perFileSamples, options.minSampleSize);
    if (effective < perFileSamples) {
      notes.push(
        effective === 1 && full.length <= budget
          ? { kind: 'short', fileName: file.name, chars: full.length }
          : { kind: 'reduced', fileName: file.name, from: perFileSamples, to: effective },
      );
    }
    blocks.push(files.length > 1 ? `\n\n===== EXCERPTS FROM: ${file.name} =====\n\n${joined}` : joined);
    meta.push({ fileName: file.name, sampleChars: joined.length, sampleCount: effective, fullTextChars: full.length });
  }
  return { text: blocks.join(''), files: meta, notes };
}
