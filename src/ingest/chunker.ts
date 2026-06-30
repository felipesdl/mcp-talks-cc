import { config } from '../config.ts';

const SEPARATORS = ['\n\n', '\n', '. ', '? ', '! ', '; ', ', ', ' ', ''];

function splitBySep(text: string, sep: string): string[] {
  if (sep === '') return Array.from(text);
  return text.split(sep).map((s, i, arr) => (i < arr.length - 1 ? s + sep : s));
}

function recursiveSplit(text: string, size: number, sepIdx = 0): string[] {
  if (text.length <= size) return [text];
  if (sepIdx >= SEPARATORS.length) {
    // hard cut
    const out: string[] = [];
    for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
    return out;
  }
  const parts = splitBySep(text, SEPARATORS[sepIdx]!);
  const out: string[] = [];
  let buf = '';
  for (const p of parts) {
    if ((buf + p).length <= size) {
      buf += p;
    } else {
      if (buf) out.push(buf);
      if (p.length > size) {
        out.push(...recursiveSplit(p, size, sepIdx + 1));
        buf = '';
      } else {
        buf = p;
      }
    }
  }
  if (buf) out.push(buf);
  return out;
}

function applyOverlap(chunks: string[], overlap: number): string[] {
  if (overlap <= 0 || chunks.length <= 1) return chunks;
  const out: string[] = [chunks[0]!];
  for (let i = 1; i < chunks.length; i++) {
    const prev = chunks[i - 1]!;
    const tail = prev.slice(Math.max(0, prev.length - overlap));
    out.push(tail + chunks[i]!);
  }
  return out;
}

export function chunkText(text: string): string[] {
  const trimmed = text.trim();
  if (trimmed.length < config.chunk.minChars) return [];
  if (trimmed.length <= config.chunk.size) return [trimmed];
  const raw = recursiveSplit(trimmed, config.chunk.size).filter((c) => c.trim().length > 0);
  return applyOverlap(raw, config.chunk.overlap);
}
