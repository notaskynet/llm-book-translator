// Port of _build_chunk_glossary_block (src/core/translator.py): the glossary for one chunk,
// as a prompt block. The cast block is not chunk-filtered; the glossary block is.

import type { LogCallback } from '../llm/types';
import { buildCastBlock, buildGlossaryBlock } from './injector';
import { filterGlossary } from './filter';
import { DEFAULT_GLOSSARY_CONFIG, type GlossaryConfig, type TermMetadata } from './models';

export interface GlossaryOptions {
  terms: Map<string, string>;
  metadata?: TermMetadata;
  config?: Partial<GlossaryConfig>;
}

/** Remembers which cap warnings were already shown, so each appears once per job. */
export interface GlossaryRuntimeState {
  glossaryCapWarned?: boolean;
  castCapWarned?: boolean;
}

export function buildChunkGlossaryBlock(
  chunk: string,
  glossary: GlossaryOptions | undefined,
  options: { log?: LogCallback; state?: GlossaryRuntimeState; targetLanguage?: string } = {},
): string {
  if (!glossary?.terms.size) return '';
  const config: GlossaryConfig = { ...DEFAULT_GLOSSARY_CONFIG, ...glossary.config };
  const state = options.state ?? {};
  const metadata = glossary.metadata ?? {};

  const { terms: filtered, capped } = filterGlossary(chunk, glossary.terms, config);
  if (capped && config.warnOnCap && !state.glossaryCapWarned) {
    state.glossaryCapWarned = true;
    options.log?.('glossary_capped', `Glossary cap reached: more than ${config.maxEntries} terms matched in a single chunk.`);
  }

  const { block: cast, capped: castCapped } = buildCastBlock(glossary.terms, metadata, config.maxCastEntries);
  if (castCapped && config.warnOnCap && !state.castCapWarned) {
    state.castCapWarned = true;
    options.log?.('glossary_cast_capped', `Cast block cap reached: more than ${config.maxCastEntries} glossary entries carry a gender.`);
  }

  const glossaryBlock = filtered.size ? buildGlossaryBlock(filtered, options.targetLanguage ?? '', metadata) : '';
  if (!cast && !glossaryBlock) return '';
  if (!cast) return glossaryBlock;
  if (!glossaryBlock) return cast;
  return `${cast}\n${glossaryBlock}`;
}
