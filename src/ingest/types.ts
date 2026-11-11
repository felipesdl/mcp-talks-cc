/** tool_output/todo existem só como flag interna do ingest (0 chunks hoje); decision vem do src/distill/. */
export type SourceKind =
  | 'conversation'
  | 'tool_output'
  | 'plan'
  | 'todo'
  | 'task_memory'
  | 'decision'
  | 'research'
  | 'pr'
  | 'repo_doc'
  | 'skill_doc';

export interface ProjectRecord {
  path: string;
  name: string;
}

export interface SessionRecord {
  id: string;
  projectPath: string;
  startedAt: string | null;
  endedAt: string | null;
  messageCount: number;
  gitBranch: string | null;
  version: string | null;
  /** cwd original quando a sessão rodou num worktree; projectPath vira o repo. */
  worktree: string | null;
  worktreeName: string | null;
  /**
   * Arquivo de subagente (`<sessão>/subagents/*.jsonl`): mesmo sessionId do pai.
   * Só completa os metadados da sessão, nunca sobrescreve os do arquivo principal.
   */
  sidechain: boolean;
}

export interface MessageRecord {
  uuid: string;
  sessionId: string;
  parentUuid: string | null;
  role: 'user' | 'assistant';
  timestamp: string;
  text: string;
  /** Slash command digitado (`<command-name>`), só em mensagem de usuário. */
  slash: string | null;
  /**
   * Evento de subagente (arquivo `subagents/` ou `isSidechain`): o "usuário"
   * ali é o agente principal mandando o prompt, não a pessoa.
   */
  sidechain: boolean;
}

export interface ToolCallRecord {
  id: string;
  messageUuid: string;
  name: string;
  outputSnippet: string;
  timestamp: string;
  /** id do `tool_use`, ou `tool_use_id` do `tool_result`: é o que pareia os dois. */
  toolUseId: string | null;
  /** Só em `tool_result`: flag `is_error` do transcript. */
  isError: boolean | null;
  errorKind: string | null;
  skill: string | null;
  agentType: string | null;
}

export interface ChunkRecord {
  id: string;
  parentKey: string; // composite key referring to parent node (Message uuid, Plan path, etc.)
  parentLabel:
    | 'Message'
    | 'Plan'
    | 'TaskMemoryDoc'
    | 'Todo'
    | 'ToolCall'
    | 'ResearchDoc'
    | 'PullRequest'
    | 'RepoDoc'
    | 'Skill';
  sourceKind: SourceKind;
  ordinal: number;
  text: string;
  /** null = reaproveita o vetor já gravado (ver embedChunks.ts). */
  embedding: number[] | null;
  /**
   * Quem falou, propagado da Message. Nulo para chunk que não vem de conversa
   * (Plan, TaskMemoryDoc) e para saída de ferramenta, que chega dentro de um
   * evento de papel `user` mas não é fala de ninguém.
   */
  role: 'user' | 'assistant' | null;
  projectPath: string | null;
  sessionId: string | null;
  timestamp: string | null;
}

export interface PlanRecord {
  path: string;
  slug: string;
  createdAt: string;
}

export interface TodoRecord {
  id: string;
  content: string;
  status: string;
  sessionId: string | null;
  filePath: string;
}

export interface TaskMemoryDocRecord {
  path: string;
  taskId: string;
  kind: string;
  /** null quando a pasta é da task (TASKS_HOME) e não declara repo. */
  projectPath: string | null;
  lastModified: string;
}

/** `meta.json` de uma pasta em TASKS_HOME. */
export interface TaskFolderRecord {
  id: string;
  path: string;
  aliases: string[];
  repos: string[];
  branches: string[];
  worktrees: string[];
  lastModified: string;
}

export interface ResearchDocRecord {
  path: string;
  title: string;
  createdAt: string;
}

export interface PullRequestRecord {
  /** `repo#número` */
  key: string;
  repo: string;
  number: number;
  title: string;
  url: string;
  state: 'OPEN' | 'MERGED' | 'CLOSED';
  createdAt: string;
  mergedAt: string | null;
  closedAt: string | null;
  branch: string | null;
  task: string;
  bodySha: string;
}

export interface RepoDocRecord {
  /** `repo:caminho` */
  key: string;
  repo: string;
  repoPath: string;
  path: string;
  sha: string;
  author: string | null;
  updatedAt: string | null;
}
