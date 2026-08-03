import { readdir, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { basename, join } from 'node:path';
import { createHash } from 'node:crypto';
import { config } from '../../config.ts';
import { chunkText } from '../chunker.ts';
import { redact } from '../redact.ts';
import { prepareConversationText } from '../quality.ts';
import { embedBatched } from '../../embeddings/localEmbedder.ts';
import { isUnchanged, markIngested, save as saveCheckpoint } from '../checkpoint.ts';
import {
  writeProjects,
  writeSessions,
  writeMessages,
  writeToolCalls,
  writeChunks,
} from '../writer.ts';
import type {
  ProjectRecord,
  SessionRecord,
  MessageRecord,
  ToolCallRecord,
  ChunkRecord,
} from '../types.ts';

interface RawEvent {
  type?: string;
  uuid?: string;
  parentUuid?: string | null;
  sessionId?: string;
  timestamp?: string | number;
  cwd?: string;
  gitBranch?: string;
  version?: string;
  message?: {
    role?: 'user' | 'assistant';
    content?: string | Array<ContentBlock>;
  };
}

interface ContentBlock {
  type?: 'text' | 'tool_use' | 'tool_result' | 'thinking' | string;
  text?: string;
  name?: string;
  input?: unknown;
  content?: string | Array<{ type?: string; text?: string }>;
  id?: string;
  tool_use_id?: string;
}

function projectNameFromPath(p: string): string {
  return basename(p) || p;
}

function tsToISO(ts: string | number | undefined): string | null {
  if (ts === undefined) return null;
  if (typeof ts === 'number') return new Date(ts).toISOString();
  // already ISO string from newer versions
  if (/^\d{4}-\d{2}-\d{2}T/.test(ts)) return ts;
  const n = Number(ts);
  if (!Number.isNaN(n)) return new Date(n).toISOString();
  return null;
}

function extractText(content: string | ContentBlock[] | undefined): {
  text: string;
  toolBlocks: ContentBlock[];
} {
  if (!content) return { text: '', toolBlocks: [] };
  if (typeof content === 'string') return { text: content, toolBlocks: [] };
  const parts: string[] = [];
  const tools: ContentBlock[] = [];
  for (const b of content) {
    if (b.type === 'text' && typeof b.text === 'string') parts.push(b.text);
    // Bloco `thinking` NÃO entra: é rascunho de raciocínio, e era a maior fonte
    // de filler navegacional no índice ("Let me check...", "I'll start with...").
    // Decisão que sobrevive ao raciocínio reaparece no texto final da resposta.
    else if (b.type === 'tool_use' || b.type === 'tool_result') tools.push(b);
  }
  return { text: parts.join('\n\n'), toolBlocks: tools };
}

function toolOutputSnippet(b: ContentBlock): string {
  if (typeof b.content === 'string') return b.content.slice(0, 500);
  if (Array.isArray(b.content)) {
    const t = b.content
      .map((c) => (typeof c?.text === 'string' ? c.text : ''))
      .filter(Boolean)
      .join('\n');
    return t.slice(0, 500);
  }
  if (b.type === 'tool_use') {
    try {
      return JSON.stringify(b.input).slice(0, 500);
    } catch {
      return '';
    }
  }
  return '';
}

const TOOL_OUTPUT_MAX = 2000;

function toolOutputFullText(b: ContentBlock): string {
  if (typeof b.content === 'string') return b.content;
  if (Array.isArray(b.content)) {
    return b.content
      .map((c) => (typeof c?.text === 'string' ? c.text : ''))
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

type EmbedInputKind = 'conversation' | 'tool_output';

interface EmbedInput {
  parentKey: string;
  parentLabel: 'Message' | 'ToolCall';
  sourceKind: EmbedInputKind;
  text: string;
  timestamp: string;
}

interface ParsedSession {
  session: SessionRecord;
  project: ProjectRecord;
  messages: MessageRecord[];
  tools: ToolCallRecord[];
  embedInputs: EmbedInput[];
}

export async function parseSessionFile(
  filePath: string,
  includeToolOutputs: boolean,
): Promise<ParsedSession | null> {
  const rl = createInterface({
    input: createReadStream(filePath, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });

  let sessionId: string | null = null;
  let projectPath: string | null = null;
  let gitBranch: string | null = null;
  let version: string | null = null;
  let firstTs: string | null = null;
  let lastTs: string | null = null;
  const messages: MessageRecord[] = [];
  const tools: ToolCallRecord[] = [];
  const embedInputs: ParsedSession['embedInputs'] = [];

  for await (const line of rl) {
    if (!line.trim()) continue;
    let ev: RawEvent;
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    if (ev.sessionId && !sessionId) sessionId = ev.sessionId;
    if (ev.cwd && !projectPath) projectPath = ev.cwd;
    if (ev.gitBranch && !gitBranch) gitBranch = ev.gitBranch;
    if (ev.version && !version) version = ev.version;

    const role = ev.message?.role;
    if (!ev.uuid || (role !== 'user' && role !== 'assistant')) continue;

    const iso = tsToISO(ev.timestamp);
    if (iso) {
      if (!firstTs || iso < firstTs) firstTs = iso;
      if (!lastTs || iso > lastTs) lastTs = iso;
    }

    const { text, toolBlocks } = extractText(ev.message?.content);
    const redacted = redact(text).trim();

    messages.push({
      uuid: ev.uuid,
      sessionId: ev.sessionId ?? sessionId ?? '',
      parentUuid: ev.parentUuid ?? null,
      role,
      timestamp: iso ?? '',
      text: redacted.slice(0, 10000),
    });

    // Gate de qualidade: limpa wrappers do harness e descarta filler/curto.
    // Message.text acima fica com o texto cru (transcript e echo dependem dele);
    // só o que vai virar embedding passa pelo filtro.
    const forEmbedding = prepareConversationText(redacted);
    if (forEmbedding) {
      embedInputs.push({
        parentKey: ev.uuid,
        parentLabel: 'Message',
        sourceKind: 'conversation',
        text: forEmbedding,
        timestamp: iso ?? '',
      });
    }

    for (let i = 0; i < toolBlocks.length; i++) {
      const tb = toolBlocks[i]!;
      const name = tb.name ?? tb.type ?? 'unknown';
      const id = `${ev.uuid}::tool::${i}`;
      tools.push({
        id,
        messageUuid: ev.uuid,
        name,
        outputSnippet: redact(toolOutputSnippet(tb)),
        timestamp: iso ?? '',
      });

      if (includeToolOutputs && tb.type === 'tool_result') {
        const fullText = redact(toolOutputFullText(tb)).trim();
        if (
          fullText.length >= config.chunk.minChars &&
          fullText.length <= TOOL_OUTPUT_MAX
        ) {
          embedInputs.push({
            parentKey: id,
            parentLabel: 'ToolCall',
            sourceKind: 'tool_output',
            text: fullText,
            timestamp: iso ?? '',
          });
        }
      }
    }
  }

  if (!sessionId || !projectPath) return null;

  return {
    session: {
      id: sessionId,
      projectPath,
      startedAt: firstTs,
      endedAt: lastTs,
      messageCount: messages.length,
      gitBranch,
      version,
    },
    project: { path: projectPath, name: projectNameFromPath(projectPath) },
    messages,
    tools,
    embedInputs,
  };
}

function buildChunks(
  parsed: ParsedSession,
): { chunks: ChunkRecord[]; texts: string[] } {
  const chunks: ChunkRecord[] = [];
  const texts: string[] = [];
  for (const e of parsed.embedInputs) {
    const pieces = chunkText(e.text);
    for (let i = 0; i < pieces.length; i++) {
      const piece = pieces[i]!;
      const id = createHash('sha1')
        .update(`${e.parentKey}::${i}::${piece.slice(0, 200)}`)
        .digest('hex');
      chunks.push({
        id,
        parentKey: e.parentKey,
        parentLabel: e.parentLabel,
        sourceKind: e.sourceKind,
        ordinal: i,
        text: piece,
        embedding: [], // filled later
        projectPath: parsed.project.path,
        sessionId: parsed.session.id,
        timestamp: e.timestamp,
      });
      texts.push(piece);
    }
  }
  return { chunks, texts };
}

// Backlog acumulado (centenas de arquivos) leva horas de embedding local.
// Sem flush periódico, morrer no meio joga fora o progresso todo, porque o
// checkpoint só é salvo no fim do run em src/ingest/index.ts.
const CHECKPOINT_FLUSH_EVERY = 10;

export interface IngestConversationsOpts {
  limit?: number;
  force?: boolean;
  fileFilter?: (path: string) => boolean;
  includeToolOutputs?: boolean;
}

export async function ingestConversations(opts: IngestConversationsOpts = {}): Promise<{
  files: number;
  sessions: number;
  messages: number;
  chunks: number;
  skipped: number;
}> {
  const projectsDir = join(config.paths.claudeHome, 'projects');
  let dirs: string[];
  try {
    dirs = await readdir(projectsDir);
  } catch {
    console.error(`[conv] no projects dir at ${projectsDir}`);
    return { files: 0, sessions: 0, messages: 0, chunks: 0, skipped: 0 };
  }

  const files: string[] = [];
  for (const d of dirs) {
    const dp = join(projectsDir, d);
    const st = await stat(dp).catch(() => null);
    if (!st?.isDirectory()) continue;
    const entries = (await readdir(dp, { recursive: true })) as string[];
    for (const f of entries) {
      if (f.endsWith('.jsonl')) {
        const fp = join(dp, f);
        if (opts.fileFilter && !opts.fileFilter(fp)) continue;
        files.push(fp);
      }
    }
  }

  files.sort();
  const target = opts.limit ? files.slice(0, opts.limit) : files;

  let totalSessions = 0;
  let totalMessages = 0;
  let totalChunks = 0;
  let skipped = 0;
  let sinceFlush = 0;

  const flush = async (): Promise<void> => {
    sinceFlush++;
    if (sinceFlush < CHECKPOINT_FLUSH_EVERY) return;
    sinceFlush = 0;
    await saveCheckpoint();
  };

  for (let i = 0; i < target.length; i++) {
    const fp = target[i]!;
    if (!opts.force && (await isUnchanged(fp))) {
      skipped++;
      continue;
    }
    const t0 = Date.now();
    const parsed = await parseSessionFile(fp, opts.includeToolOutputs ?? false);
    if (!parsed) {
      await markIngested(fp);
      await flush();
      continue;
    }

    await writeProjects([parsed.project]);
    await writeSessions([parsed.session]);
    await writeMessages(parsed.messages);
    await writeToolCalls(parsed.tools);

    const { chunks, texts } = buildChunks(parsed);
    if (chunks.length > 0) {
      const vecs = await embedBatched(texts);
      for (let j = 0; j < chunks.length; j++) chunks[j]!.embedding = vecs[j]!;
      await writeChunks(chunks);
    }

    await markIngested(fp);
    await flush();

    totalSessions++;
    totalMessages += parsed.messages.length;
    totalChunks += chunks.length;
    console.error(
      `[conv] ${i + 1}/${target.length} ${basename(fp)} — ${parsed.messages.length}msg ${chunks.length}chunk ${Date.now() - t0}ms`,
    );
  }

  return {
    files: target.length,
    sessions: totalSessions,
    messages: totalMessages,
    chunks: totalChunks,
    skipped,
  };
}
