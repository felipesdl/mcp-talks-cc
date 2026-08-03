import { homedir } from 'node:os';
import { join } from 'node:path';

function env(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined) throw new Error(`Missing env var: ${name}`);
  return v;
}

const HOME = homedir();

export const config = {
  neo4j: {
    uri: env('NEO4J_URI', 'bolt://localhost:7687'),
    user: env('NEO4J_USER', 'neo4j'),
    password: env('NEO4J_PASSWORD', 'password'),
    database: env('NEO4J_DATABASE', 'neo4j'),
  },
  embed: {
    model: env('EMBED_MODEL', 'Xenova/bge-m3'),
    dim: parseInt(env('EMBED_DIM', '1024'), 10),
    batchSize: parseInt(env('EMBED_BATCH', '32'), 10),
  },
  paths: {
    claudeHome: env('CLAUDE_HOME', join(HOME, '.claude')),
    codeHome: env('CODE_HOME', join(HOME, 'Documents/code')),
    cacheDir: env('CACHE_DIR', join(HOME, '.cache/mcp-talks-cc')),
  },
  chunk: {
    size: 800,
    overlap: 150,
    minChars: 40, // skip near-empty messages (plan/todo/task_memory)
  },
  // Gate de qualidade só de conversa (ver src/ingest/quality.ts). Plan/todo/
  // task_memory são documentos, não têm o problema de filler navegacional.
  quality: {
    /** Abaixo disso não sobra nada nem com sinal de código. */
    hardFloorChars: 40,
    /**
     * Floor pra texto SEM sinal de conteúdo. Conservador de propósito: o filtro
     * de `filler` já pega a família de anúncio independente de tamanho, então o
     * único trabalho deste floor é chatter de processo ("boa, vamos fazer os
     * commits + push"). Em 80 o dry-run derrubava conclusão curta de verdade
     * ("All 3 conflicts trivial, additivos, ortogonais"), então 60: com pool de
     * recall de 500 e MMR, ruído leve custa menos que sinal perdido.
     */
    minConversationChars: 60,
  },
} as const;

export type AppConfig = typeof config;
