#!/usr/bin/env node
// Atualiza a seção "Memória cross-conversa" do ~/.claude/CLAUDE.md com o
// conteúdo de docs/CLAUDE.md.snippet.md.
//
//   npm run upgrade:claude-md -- --dry-run   # só mostra o diff
//   npm run upgrade:claude-md -- --apply     # aplica, com backup
//
// A seção vai do marcador `mcp-talks-cc:snippet` (ou do heading, em
// instalação anterior ao marcador) até o próximo heading de nível 2. O resto
// do arquivo não é tocado. Sem a seção, o bloco entra no fim.
//
// Quem customizou a seção perde a customização: por isso o fluxo do primer
// sempre mostra o diff e pergunta antes do --apply.
import { readFileSync, writeFileSync, copyFileSync, existsSync, mkdtempSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const APPLY = process.argv.includes('--apply');
const TARGET = process.env.CLAUDE_MD ?? join(homedir(), '.claude', 'CLAUDE.md');
const projectDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const HEADING = '## Memória cross-conversa';
const MARKER = '<!-- mcp-talks-cc:snippet';

// bloco novo: do marcador até o fim do snippet, com o path real da instalação
const snippetRaw = readFileSync(join(projectDir, 'docs', 'CLAUDE.md.snippet.md'), 'utf8');
const start = snippetRaw.indexOf(MARKER);
if (start < 0) {
  console.error('[claude-md] snippet sem marcador, abortando.');
  process.exit(1);
}
const block = snippetRaw
  .slice(start)
  .replaceAll('/ABSOLUTE/PATH/TO/mcp-talks-cc', projectDir)
  .trimEnd() + '\n';

const current = existsSync(TARGET) ? readFileSync(TARGET, 'utf8') : '';
const lines = current.split('\n');
let from = lines.findIndex((l) => l.startsWith(MARKER));
if (from < 0) from = lines.findIndex((l) => l.startsWith(HEADING));
let next;
if (from >= 0) {
  // pula o próprio heading (e o marcador, se houver) antes de procurar o fim
  let i = from;
  while (i < lines.length && (lines[i].startsWith(MARKER) || lines[i].startsWith(HEADING))) i++;
  const rel = lines.slice(i).findIndex((l) => /^## /.test(l));
  next = rel < 0 ? lines.length : i + rel;
}
const updated =
  from < 0
    ? `${current.trimEnd()}\n\n${block}`
    : [...lines.slice(0, from), ...block.trimEnd().split('\n'), '', ...lines.slice(next)].join('\n');

if (updated === current) {
  console.log('[claude-md] já está atualizado, nada a fazer.');
  process.exit(0);
}

if (!APPLY) {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-claude-md-'));
  const a = join(dir, 'atual.md');
  const b = join(dir, 'novo.md');
  writeFileSync(a, current);
  writeFileSync(b, updated);
  const d = spawnSync('diff', ['-u', a, b], { encoding: 'utf8' });
  process.stdout.write(d.stdout || '(diff indisponível)\n');
  console.log(`\n[claude-md] dry-run: nada escrito. Seção ${from < 0 ? 'nova (fim do arquivo)' : 'substituída'} em ${TARGET}.`);
  console.log('[claude-md] aplicar: npm run upgrade:claude-md -- --apply');
  process.exit(0);
}

if (existsSync(TARGET)) {
  const bak = `${TARGET}.bak-${new Date().toISOString().slice(0, 10)}`;
  copyFileSync(TARGET, bak);
  console.log(`[claude-md] backup: ${bak}`);
}
writeFileSync(TARGET, updated);
console.log(`[claude-md] seção de memória atualizada em ${TARGET}.`);
