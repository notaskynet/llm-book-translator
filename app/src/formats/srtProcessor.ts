// Port of src/core/srt_processor.py (the parts the translation pipeline uses).

export interface Subtitle {
  number: string;
  startTime: string;
  endTime: string;
  text: string;
  originalText: string;
}

const TIMECODE = /^(\d{2}:\d{2}:\d{2},\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2},\d{3})/;

export function parseSrt(content: string): Subtitle[] {
  let text = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  if (!text.endsWith('\n')) text += '\n';

  const subtitles: Subtitle[] = [];
  for (const rawBlock of text.split('\n\n')) {
    const block = rawBlock.trim();
    if (!block) continue;
    const lines = block.split('\n');
    if (lines.length < 3) continue;
    if (!/^\d+$/.test(lines[0])) continue;
    const timecode = TIMECODE.exec(lines[1]);
    if (!timecode) continue;
    const body = lines.slice(2).join('\n');
    subtitles.push({ number: lines[0], startTime: timecode[1], endTime: timecode[2], text: body, originalText: body });
  }
  return subtitles;
}

/** Groups subtitles into blocks of `linesPerBlock` non-empty cues (empty cues ride along). */
export function groupSubtitlesForTranslation(
  subtitles: Subtitle[],
  linesPerBlock = 5,
  maxCharsPerBlock = 500,
): Subtitle[][] {
  const blocks: Subtitle[][] = [];
  let current: Subtitle[] = [];
  let currentChars = 0;

  for (const subtitle of subtitles) {
    const text = subtitle.text.trim();
    if (!text) {
      if (current.length) current.push(subtitle);
      continue;
    }
    const exceedsLines = current.length >= linesPerBlock;
    const exceedsChars = currentChars + text.length > maxCharsPerBlock;
    if (current.length && (exceedsLines || exceedsChars)) {
      blocks.push(current);
      current = [];
      currentChars = 0;
    }
    current.push(subtitle);
    currentChars += text.length;
  }
  if (current.length) blocks.push(current);
  return blocks;
}

function fixMultipleIndicesOnSameLine(text: string): string {
  return text.replace(/(\S.*?)\s+(\[\d+\])/g, '$1\n$2');
}

/** Maps `[N]`-marked LLM output with block-local indices back to global subtitle indices. */
export function extractBlockTranslationsWithRemapping(
  translatedText: string,
  localToGlobal: Map<number, number>,
): Map<number, string> {
  const translations = new Map<number, string>();
  const lines = fixMultipleIndicesOnSameLine(translatedText).trim().split('\n');

  let currentLocal: number | null = null;
  let currentLines: string[] = [];
  const flush = () => {
    if (currentLocal === null || !currentLines.length) return;
    const global = localToGlobal.get(currentLocal);
    if (global !== undefined) translations.set(global, currentLines.join('\n').trim());
  };

  for (const line of lines) {
    const m = /^\[(\d+)\](.*)$/.exec(line);
    if (m) {
      flush();
      currentLocal = Number.parseInt(m[1], 10);
      const remaining = m[2].trim();
      currentLines = remaining ? [remaining] : [];
    } else if (currentLocal !== null) {
      currentLines.push(line);
    }
  }
  flush();
  return translations;
}

export function reconstructSrt(subtitles: Subtitle[], attribution?: string): string {
  const blocks = subtitles.map((s) => `${s.number}\n${s.startTime} --> ${s.endTime}\n${s.text}\n`);
  if (attribution) blocks.push(`\n${attribution}\n`);
  return blocks.join('\n');
}
