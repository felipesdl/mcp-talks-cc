export type SourceKind = 'conversation' | 'tool_output' | 'plan' | 'todo' | 'task_memory';

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
}

export interface MessageRecord {
  uuid: string;
  sessionId: string;
  parentUuid: string | null;
  role: 'user' | 'assistant';
  timestamp: string;
  text: string;
}

export interface ToolCallRecord {
  id: string;
  messageUuid: string;
  name: string;
  outputSnippet: string;
  timestamp: string;
}

export interface ChunkRecord {
  id: string;
  parentKey: string; // composite key referring to parent node (Message uuid, Plan path, etc.)
  parentLabel: 'Message' | 'Plan' | 'TaskMemoryDoc' | 'Todo' | 'ToolCall';
  sourceKind: SourceKind;
  ordinal: number;
  text: string;
  embedding: number[];
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
  projectPath: string;
  lastModified: string;
}
