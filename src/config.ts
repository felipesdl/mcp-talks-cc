import { homedir } from 'node:os';
import { join } from 'node:path';

function env(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined) throw new Error(`Missing env var: ${name}`);
  return v;
}

const HOME = homedir();
const CODE_HOME = env('CODE_HOME', join(HOME, 'Documents/code'));

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
    /** intraOpNumThreads do onnx. 0 = decide sozinho (ver localEmbedder.ts). */
    threads: parseInt(env('EMBED_THREADS', '0'), 10) || 0,
  },
  paths: {
    claudeHome: env('CLAUDE_HOME', join(HOME, '.claude')),
    codeHome: CODE_HOME,
    cacheDir: env('CACHE_DIR', join(HOME, '.cache/mcp-talks-cc')),
    /**
     * Pasta de trabalho por task, fora de qualquer repo: `<TASKS_HOME>/<id>/*.md`
     * + `meta.json`. O id é a key do Jira ou um provisório (nome do worktree)
     * até a task existir. Apagada pelo tasks:gc depois de ingerida.
     */
    tasksHome: env('TASKS_HOME', join(CODE_HOME, '.claude/tasks')),
    /** Notas de pesquisa salvas de propósito. Duráveis: o gc nunca toca. */
    researchHome: env('RESEARCH_HOME', join(CODE_HOME, '.claude/research')),
  },
  /**
   * Dono (org/usuário) dos PRs no GitHub. Vazio desliga o sync de PRs.
   * Os PRs são achados pela key da task no título ou pela branch.
   */
  github: {
    prOwner: env('GH_PR_OWNER', ''),
    /** Task sem sessão há mais que isso (e sem PR aberto) para de ser consultada. */
    activeDays: parseInt(env('GH_PR_ACTIVE_DAYS', '45'), 10),
    maxTasksPerRun: parseInt(env('GH_PR_MAX_TASKS', '30'), 10),
  },
  /** Markdown versionado na branch padrão de cada repo em CODE_HOME. */
  repoDocs: {
    enabled: env('REPO_DOCS', '1') === '1',
    /** Prefixos de caminho a ignorar, separados por vírgula (ex.: `docs/tmp/,legacy/`). */
    exclude: env('REPO_DOCS_EXCLUDE', '')
      .split(',')
      .map((x) => x.trim())
      .filter(Boolean),
    maxBytes: 200_000,
  },
  taskFolders: {
    /** Pasta sem PR mergeado e sem mexer há N dias sai depois de ingerida. */
    idleDays: parseInt(env('TASKS_IDLE_DAYS', '30'), 10),
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
