import { readdir, readFile, stat } from 'node:fs/promises';
import type { Stats } from 'node:fs';
import { basename, join } from 'node:path';
import { createHash } from 'node:crypto';
import { config } from '../../config.ts';
import { chunkText } from '../chunker.ts';
import { redact } from '../redact.ts';
import { embedChunks } from '../embedChunks.ts';
import { fingerprint, isUnchanged, markIngested } from '../checkpoint.ts';
import type { Fingerprint } from '../checkpoint.ts';
import { countReadError } from '../fsErrors.ts';
import { writePlans, writeChunks } from '../writer.ts';
import type { PlanRecord, ChunkRecord } from '../types.ts';

export async function ingestPlans(opts: { force?: boolean } = {}): Promise<{
  files: number;
  chunks: number;
  skipped: number;
  vanished: number;
  failed: number;
}> {
  const dir = join(config.paths.claudeHome, 'plans');
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    console.error(`[plans] no dir at ${dir}`);
    return { files: 0, chunks: 0, skipped: 0, vanished: 0, failed: 0 };
  }

  const mdFiles = entries.filter((f) => f.endsWith('.md')).map((f) => join(dir, f));
  let totalChunks = 0;
  let skipped = 0;
  const readErrors = { vanished: 0, failed: 0 };
  const plans: PlanRecord[] = [];
  const allChunks: ChunkRecord[] = [];

  for (const fp of mdFiles) {
    let st: Stats;
    let content: string;
    let print: Fingerprint;
    try {
      if (!opts.force && (await isUnchanged(fp))) {
        skipped++;
        continue;
      }
      print = await fingerprint(fp);
      st = await stat(fp);
      content = await readFile(fp, 'utf8');
    } catch (err) {
      countReadError('plans', basename(fp), err, readErrors);
      continue;
    }
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
        // Documento, não fala de ninguém.
        role: null,
        projectPath: null,
        sessionId: null,
        timestamp: st.mtime.toISOString(),
      });
    }
    await markIngested(fp, print);
  }

  if (plans.length > 0) {
    await writePlans(plans);
  }
  if (allChunks.length > 0) {
    await embedChunks(allChunks, opts.force);
    await writeChunks(allChunks);
    totalChunks = allChunks.length;
  }

  return { files: plans.length, chunks: totalChunks, skipped, ...readErrors };
}
