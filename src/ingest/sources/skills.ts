import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { createHash } from 'node:crypto';
import { config } from '../../config.ts';
import { chunkText } from '../chunker.ts';
import { redact } from '../redact.ts';
import { embedChunks } from '../embedChunks.ts';
import { withSession } from '../../neo4j/driver.ts';
import { writeChunks, deleteChunksOf } from '../writer.ts';
import type { ChunkRecord } from '../types.ts';

/**
 * Catálogo das skills e commands instalados: o que cada uma diz que faz. É o
 * que permite checar se uma regra destilada de correção já está escrita em
 * alguma skill (description ou corpo), e mostrar a description no my_flow.
 *
 * Fontes: $CLAUDE_HOME/skills/<dir>/SKILL.md (custom), skills sincronizadas,
 * plugins instalados (installed_plugins.json, prefixo `<plugin>:`) e
 * <CODE_HOME>/<repo>/.claude/{skills,commands} (origem `project:<repo>`).
 * O nome do nó é o nome com que a skill é CHAMADA, que é o que a tool Skill grava.
 */

export interface SkillDoc {
  name: string;
  origin: string;
  path: string;
  description: string;
  body: string;
}

/** Frontmatter YAML simples: `name:` e `description:` (inline, aspas ou bloco `>`). */
export function parseSkillMd(raw: string): { name: string | null; description: string; body: string } {
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(raw);
  if (!m) return { name: null, description: '', body: raw };
  const fm = m[1]!;
  const name = /^name:\s*["']?([^"'\n]+)["']?\s*$/m.exec(fm)?.[1]?.trim() ?? null;
  let description = '';
  const d = /^description:\s*(.*)$/m.exec(fm);
  if (d) {
    const first = d[1]!.trim();
    if (first === '>' || first === '|' || first === '>-' || first === '|-' || first === '') {
      const after = fm.slice(fm.indexOf(d[0]) + d[0].length).split('\n');
      const lines: string[] = [];
      for (const l of after.slice(1)) {
        if (/^\S/.test(l)) break;
        lines.push(l.trim());
      }
      description = lines.join(' ').trim();
    } else {
      description = first.replace(/^["']|["']$/g, '');
    }
  }
  return { name, description, body: m[2] ?? '' };
}

async function isFile(p: string): Promise<boolean> {
  return !!(await stat(p).catch(() => null))?.isFile();
}

async function skillDirs(root: string, origin: string, prefix: string): Promise<SkillDoc[]> {
  const out: SkillDoc[] = [];
  for (const e of await readdir(root, { withFileTypes: true }).catch(() => [])) {
    const p = join(root, e.name, 'SKILL.md');
    // symlink quebrado: stat falha e a skill fica de fora
    if (!(await isFile(p))) continue;
    const raw = await readFile(p, 'utf8');
    const f = parseSkillMd(raw);
    out.push({ name: `${prefix}${f.name ?? e.name}`, origin, path: p, description: f.description, body: f.body });
  }
  return out;
}

async function commandFiles(root: string, origin: string, prefix: string): Promise<SkillDoc[]> {
  const out: SkillDoc[] = [];
  for (const e of await readdir(root, { withFileTypes: true }).catch(() => [])) {
    if (!e.name.endsWith('.md')) continue;
    const p = join(root, e.name);
    if (!(await isFile(p))) continue;
    const f = parseSkillMd(await readFile(p, 'utf8'));
    out.push({ name: `${prefix}${basename(e.name, '.md')}`, origin, path: p, description: f.description, body: f.body });
  }
  return out;
}

export async function listSkillDocs(): Promise<SkillDoc[]> {
  const home = config.paths.claudeHome;
  const docs: SkillDoc[] = [];
  docs.push(...(await skillDirs(join(home, 'skills'), 'custom', '')));
  for (const b of await readdir(join(home, 'skills', 'synced'), { withFileTypes: true }).catch(() => [])) {
    if (b.isDirectory()) docs.push(...(await skillDirs(join(home, 'skills', 'synced', b.name), 'synced', 'anthropic-skills:')));
  }
  try {
    const installed = JSON.parse(await readFile(join(home, 'plugins', 'installed_plugins.json'), 'utf8')) as {
      plugins?: Record<string, Array<{ installPath?: string }>>;
    };
    for (const [id, list] of Object.entries(installed.plugins ?? {})) {
      const plugin = id.split('@')[0]!;
      const path = list[list.length - 1]?.installPath;
      if (!path) continue;
      docs.push(...(await skillDirs(join(path, 'skills'), `plugin:${plugin}`, `${plugin}:`)));
      docs.push(...(await commandFiles(join(path, 'commands'), `plugin:${plugin}`, `${plugin}:`)));
    }
  } catch {
    // sem plugins
  }
  for (const r of await readdir(config.paths.codeHome, { withFileTypes: true }).catch(() => [])) {
    if (!r.isDirectory() || r.name.startsWith('.')) continue;
    const base = join(config.paths.codeHome, r.name, '.claude');
    docs.push(...(await skillDirs(join(base, 'skills'), `project:${r.name}`, '')));
    docs.push(...(await commandFiles(join(base, 'skills'), `project:${r.name}`, '')));
    docs.push(...(await commandFiles(join(base, 'commands'), `project:${r.name}`, '')));
  }
  // Mesmo nome em dois lugares: fica o primeiro (custom > synced > plugin > projeto).
  const seen = new Set<string>();
  return docs.filter((d) => (seen.has(d.name) ? false : (seen.add(d.name), true)));
}

export async function ingestSkills(opts: { force?: boolean } = {}): Promise<{ skills: number; changed: number; chunks: number }> {
  const docs = await listSkillDocs();
  const shaOf = (d: SkillDoc): string => createHash('sha1').update(`${d.description}\n${d.body}`).digest('hex');
  const prev = await withSession(async (s) => {
    const r = await s.run(`MATCH (k:Skill) RETURN k.name AS n, k.docSha AS sha`);
    return new Map(r.records.map((x) => [x.get('n') as string, x.get('sha') as string | null]));
  });
  const changed = docs.filter((d) => opts.force || prev.get(d.name) !== shaOf(d));
  const chunks: ChunkRecord[] = [];
  for (const d of changed) {
    const sha = shaOf(d);
    chunkText(redact(`${d.name}: ${d.description}\n\n${d.body}`)).forEach((piece, i) => {
      chunks.push({
        id: createHash('sha1').update(`skill:${d.name}::${sha}::${i}`).digest('hex'),
        parentKey: d.name,
        parentLabel: 'Skill',
        sourceKind: 'skill_doc',
        ordinal: i,
        text: piece,
        embedding: [],
        role: null,
        projectPath: null,
        sessionId: null,
        timestamp: null,
      });
    });
  }
  await withSession(async (s) => {
    await s.run(
      `UNWIND $rows AS r
       MERGE (k:Skill { name: r.name })
       SET k.origin = r.origin, k.path = r.path, k.description = r.description, k.docSha = r.sha,
           k.exists = true, k.kind = coalesce(k.kind, 'skill')`,
      { rows: docs.map((d) => ({ name: d.name, origin: d.origin, path: d.path, description: d.description.slice(0, 2000), sha: shaOf(d) })) },
    );
    // Skill que sumiu do disco continua no grafo (o histórico de uso vale).
    await s.run(`MATCH (k:Skill) WHERE k.path IS NOT NULL AND NOT k.name IN $names SET k.exists = false`, {
      names: docs.map((d) => d.name),
    });
  });
  if (chunks.length > 0) await embedChunks(chunks, opts.force);
  await deleteChunksOf('Skill', 'name', changed.map((d) => d.name), chunks.map((c) => c.id));
  if (chunks.length > 0) await writeChunks(chunks);
  return { skills: docs.length, changed: changed.length, chunks: chunks.length };
}
