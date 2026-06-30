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
    minChars: 40, // skip near-empty messages
  },
} as const;

export type AppConfig = typeof config;
