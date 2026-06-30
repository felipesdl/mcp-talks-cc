#!/usr/bin/env node
// Instala (idempotente) os hooks SessionStart do mcp-talks-cc:
//   1. session-ingest.sh  (async)    — auto-ingest incremental + self-tune
//   2. session-primer.sh  (síncrono) — injeta primer aprendido como additionalContext
// Faz merge em ~/.claude/settings.json SEM sobrescrever hooks existentes.
// Backup em settings.json.bak antes de escrever; valida JSON antes de salvar.
import { readFileSync, writeFileSync, existsSync, copyFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SETTINGS = join(homedir(), '.claude', 'settings.json');
const scriptDir = dirname(fileURLToPath(import.meta.url));

// marker = nome do script; idempotência procura por ele no command.
// session-primer NÃO leva async: o stdout precisa ser capturado pelo Claude Code.
const HOOKS = [
  { marker: 'session-ingest.sh', extra: { async: true } },
  { marker: 'session-primer.sh', extra: {} },
];

function load() {
  if (!existsSync(SETTINGS)) return {};
  const raw = readFileSync(SETTINGS, 'utf8');
  try {
    return JSON.parse(raw);
  } catch (e) {
    console.error(`[install-hook] ${SETTINGS} não é JSON válido, abortando.`);
    throw e;
  }
}

const settings = load();
settings.hooks ??= {};
settings.hooks.SessionStart ??= [];

let added = 0;
for (const { marker, extra } of HOOKS) {
  const already = settings.hooks.SessionStart.some((entry) =>
    (entry.hooks ?? []).some((h) => typeof h.command === 'string' && h.command.includes(marker)),
  );
  if (already) {
    console.log(`[install-hook] ${marker} já presente, pulando.`);
    continue;
  }
  const command = `bash ${resolve(scriptDir, marker)}`;
  settings.hooks.SessionStart.push({
    matcher: '.*',
    hooks: [{ type: 'command', command, ...extra }],
  });
  console.log(`[install-hook] registrando: ${command}`);
  added++;
}

if (added === 0) {
  console.log('[install-hook] nada a fazer.');
  process.exit(0);
}

// Valida que o objeto serializa antes de tocar no arquivo.
const out = JSON.stringify(settings, null, 2) + '\n';
JSON.parse(out);

if (existsSync(SETTINGS)) copyFileSync(SETTINGS, `${SETTINGS}.bak`);
writeFileSync(SETTINGS, out);
console.log(`[install-hook] ${added} hook(s) SessionStart instalado(s). Backup: ${SETTINGS}.bak`);
