import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { createHash } from 'node:crypto';
import { config } from '../../config.ts';
import { chunkText } from '../chunker.ts';
import { redact } from '../redact.ts';
import { embedBatched } from '../../embeddings/localEmbedder.ts';
import { isUnchanged, markIngested } from '../checkpoint.ts';
import { writePlans, writeChunks } from '../writer.ts';
import type { PlanRecord, ChunkRecord } from '../types.ts';

export async function ingestPlans(opts: { force?: boolean } = {}): Promise<{
  files: number;
  chunks: number;
  skipped: number;
}> {
  const dir = join(config.paths.claudeHome, 'plans');
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    console.error(`[plans] no dir at ${dir}`);
    return { files: 0, chunks: 0, skipped: 0 };
  }

  const mdFiles = entries.filter((f) => f.endsWith('.md')).map((f) => join(dir, f));
  let totalChunks = 0;
  let skipped = 0;
  const plans: PlanRecord[] = [];
  const allChunks: ChunkRecord[] = [];
  const allTexts: string[] = [];

  for (const fp of mdFiles) {
    if (!opts.force && (await isUnchanged(fp))) {
      skipped++;
      continue;
    }
    const st = await stat(fp);
    const content = await readFile(fp, 'utf8');
    const slug = basename(fp, '.md');

    plans.push({
      path: fp,
      slug,
      createdAt: st.birthtime.toISOString(),
    });

    const redacted = redact(content);
    const pieces = chunkText(redacted);
    for (let i = 0; i < pieces.length; i++) {
      const piece = pieces[i]!;
      const id = createHash('sha1').update(`${fp}::${i}`).digest('hex');
      allChunks.push({
        id,
        parentKey: fp,
        parentLabel: 'Plan',
        sourceKind: 'plan',
        ordinal: i,
        text: piece,
        embedding: [],
        projectPath: null,
        sessionId: null,
        timestamp: st.mtime.toISOString(),
      });
      allTexts.push(piece);
    }
    await markIngested(fp);
  }

  if (plans.length > 0) {
    await writePlans(plans);
  }
  if (allChunks.length > 0) {
    const vecs = await embedBatched(allTexts);
    for (let j = 0; j < allChunks.length; j++) allChunks[j]!.embedding = vecs[j]!;
    await writeChunks(allChunks);
    totalChunks = allChunks.length;
  }

  return { files: plans.length, chunks: totalChunks, skipped };
}
