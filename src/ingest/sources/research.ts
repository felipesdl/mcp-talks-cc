import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { createHash } from 'node:crypto';
import { config } from '../../config.ts';
import { chunkText } from '../chunker.ts';
import { redact } from '../redact.ts';
import { embedChunks } from '../embedChunks.ts';
import { fingerprint, isUnchanged, markIngested } from '../checkpoint.ts';
import type { Fingerprint } from '../checkpoint.ts';
import { countReadError } from '../fsErrors.ts';
import { writeResearchDocs, writeChunks, deleteChunksOf } from '../writer.ts';
import type { ResearchDocRecord, ChunkRecord } from '../types.ts';

/**
 * Notas de pesquisa salvas de propósito (`<RESEARCH_HOME>/**.md`). Duráveis,
 * ao contrário da pasta de task: conclusão de investigação que não virou
 * feature continua valendo como "já olhamos isso, deu X".
 */

/** Primeiro heading vira o título; sem heading, o nome do arquivo. */
export function researchTitle(content: string, file: string): string {
  const m = /^#\s+(.+)$/m.exec(content);
  return (m?.[1] ?? basename(file, '.md')).trim().slice(0, 200);
}

export async function ingestResearch(opts: { force?: boolean } = {}): Promise<{
  docs: number;
  chunks: number;
  skipped: number;
  vanished: number;
  failed: number;
}> {
  const root = config.paths.researchHome;
  const entries = ((await readdir(root, { recursive: true }).catch(() => [])) as string[]).filter((f) =>
    f.endsWith('.md'),
  );
  const docs: ResearchDocRecord[] = [];
  const chunks: ChunkRecord[] = [];
  const changed: string[] = [];
  const readErrors = { vanished: 0, failed: 0 };
  let skipped = 0;

  for (const rel of entries) {
    const fp = join(root, rel);
    let content: string;
    let print: Fingerprint;
    let mtime: string;
    try {
      if (!opts.force && (await isUnchanged(fp))) {
        skipped++;
        continue;
      }
      print = await fingerprint(fp);
      mtime = (await stat(fp)).mtime.toISOString();
      content = await readFile(fp, 'utf8');
    } catch (err) {
      countReadError('research', basename(fp), err, readErrors);
      continue;
    }
    docs.push({ path: fp, title: researchTitle(content, fp), createdAt: mtime });
    const pieces = chunkText(redact(content));
    pieces.forEach((piece, i) => {
      chunks.push({
        id: createHash('sha1').update(`${fp}::${i}`).digest('hex'),
        parentKey: fp,
        parentLabel: 'ResearchDoc',
        sourceKind: 'research',
        ordinal: i,
        text: piece,
        embedding: [],
        role: null,
        projectPath: null,
        sessionId: null,
        timestamp: mtime,
      });
    });
    changed.push(fp);
    await markIngested(fp, print);
  }

  if (docs.length > 0) await writeResearchDocs(docs);
  if (chunks.length > 0) await embedChunks(chunks, opts.force);
  await deleteChunksOf('ResearchDoc', 'path', changed, chunks.map((c) => c.id));
  if (chunks.length > 0) await writeChunks(chunks);
  return { docs: docs.length, chunks: chunks.length, skipped, ...readErrors };
}
