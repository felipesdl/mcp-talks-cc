#!/usr/bin/env node
// Instala (idempotente) os hooks do mcp-talks-cc:
//   1. SessionStart     session-ingest.sh (async): auto-ingest incremental + self-tune
//   2. SessionStart     session-primer.sh (síncrono): injeta primer aprendido
//   3. UserPromptSubmit push-recall.sh prompt: ponteiro de memória por prompt
//   4. PostToolUse      push-recall.sh file (Read|Edit|Write): histórico do arquivo
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
// Os de push são síncronos (o stdout vira contexto) e têm timeout curto: o
// script já é fail-open, o timeout é a segunda rede.
const HOOKS = [
  { event: 'SessionStart', marker: 'session-ingest.sh', script: 'session-ingest.sh', matcher: '.*', extra: { async: true } },
  { event: 'SessionStart', marker: 'session-primer.sh', script: 'session-primer.sh', matcher: '.*', extra: {} },
  { event: 'UserPromptSubmit', marker: 'push-recall.sh prompt', script: 'push-recall.sh', args: ' prompt', extra: { timeout: 3 } },
  { event: 'PostToolUse', marker: 'push-recall.sh file', script: 'push-recall.sh', args: ' file', matcher: 'Read|Edit|Write|MultiEdit', extra: { timeout: 3 } },
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

let added = 0;
for (const { event, marker, script, args = '', matcher, extra } of HOOKS) {
  settings.hooks[event] ??= [];
  const already = settings.hooks[event].some((entry) =>
    (entry.hooks ?? []).some((h) => typeof h.command === 'string' && h.command.includes(marker)),
  );
  if (already) {
    console.log(`[install-hook] ${marker} já presente, pulando.`);
    continue;
  }
  const command = `bash ${resolve(scriptDir, script)}${args}`;
  settings.hooks[event].push({
    ...(matcher ? { matcher } : {}),
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
console.log(`[install-hook] ${added} hook(s) instalado(s). Backup: ${SETTINGS}.bak`);
