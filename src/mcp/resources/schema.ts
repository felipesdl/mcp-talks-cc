import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { withSession } from '../../neo4j/driver.ts';

/**
 * Inventário de nós e arestas lido do banco, não escrito à mão.
 *
 * A versão anterior era 92 linhas de markdown fixo, e já estava errada antes de
 * qualquer mudança nova: documentava `HAS_TODO`, que nunca produziu uma aresta
 * sequer, e descrevia o score como `RRF: 1/(60+rank_vec) + 1/(60+rank_bm25)`, substituído por RRF.
 * Doc de schema mantida à mão drifta; gerar é a única forma de não voltar a
 * mentir. O glossário semântico abaixo continua escrito à mão porque ISSO o
 * banco não sabe dizer.
 */
async function liveInventory(): Promise<string> {
  try {
    return await withSession(async (s) => {
      const nodes = await s.run(
        `CALL db.labels() YIELD label
         CALL (label) { WITH label MATCH (n) WHERE label IN labels(n) RETURN count(n) AS n }
         RETURN label, n ORDER BY n DESC`,
      );
      const edges = await s.run(
        `CALL db.relationshipTypes() YIELD relationshipType AS t
         CALL (t) { WITH t MATCH ()-[r]->() WHERE type(r) = t RETURN count(r) AS n }
         RETURN t, n ORDER BY n DESC`,
      );
      const fmt = (rs: { get: (k: string) => unknown }[], a: string, b: string): string =>
        rs.map((r) => `- ${String(r.get(a))} — ${String(r.get(b))}`).join('\n');
      return [
        '## Nodes (live count)',
        fmt(nodes.records, 'label', 'n'),
        '',
        '## Edges (live count)',
        fmt(edges.records, 't', 'n'),
      ].join('\n');
    });
  } catch {
    return '_(inventário indisponível: Neo4j fora do ar)_';
  }
}

const SCHEMA_DOC = `# mcp-talks-cc — Neo4j schema

## Nodes
- Project { path, name, lastIndexed }                  — one per repo (worktrees collapse into the repo)
- Session { id, projectPath, startedAt, endedAt,
            messageCount, gitBranch, version,
            worktree, worktreeName, kind }             — one per session (main JSONL + subagents);
                                                        kind = implementation | research (no file write, no PR)
- Message { uuid, sessionId, role, timestamp,
            parentUuid, text, slash, sidechain,
            correction, correctionSignals,
            correctionText }                           — one per user/assistant event. sidechain = subagent
                                                        event (its "user" is the main agent). correction =
                                                        strong|weak when the user corrects the previous step
- ToolCall { id, name, outputSnippet, timestamp,
            toolUseId, isError, errorKind, errorSource,
            skill, agentType }                         — tool_use/tool_result blocks. errorKind = rejected |
                                                        interrupted | hook | tool_error | exit | other;
                                                        errorSource = flag (transcript) | text (pruned session)
- Skill { name, kind skill|command, origin, description,
          path, exists }                               — installed skills/commands (source skills) + any name
                                                        called via the Skill tool or a slash command
- AgentType { name }                                   — subagent type (Explore, general-purpose, plugin:agent)
- Chunk { id, text, embedding (vec 1024 cosine),
          ordinal, sourceKind, projectPath,
          sessionId, timestamp }                       — embeddable unit
- Plan { path, slug, createdAt }                       — ~/.claude/plans/*.md
- Todo { ... } :Orphan                                — fonte dormente: ~/.claude/todos sumiu do disco;
                                                        os 72 nós referenciam sessões inexistentes
- Task { key, prefix, sessionCount,
         firstSeenAt, lastSeenAt }                    — EDC-1200 etc, da branch e do texto
  :Epic / :Story { title, bucket, childCount,
                   childRepos, bucketHint }           — label extra no mesmo nó Task quando é pai
                                                        (link:epics); bucket = epic balde (Bugs,
                                                        Débitos técnicos): filhas sem relação
- Decision { id, kind, text, scope, repo,
             projectPath, taskKeys, confidence,
             status, createdAt }                       — regra/decisão/gotcha destilado (distill)
- File { key, repo, path, ext, sessionCount, idf }    — arquivo tocado, do input do ToolCall
- TaskMemoryDoc { path, taskId, kind, projectPath,
                  lastModified }                       — task folder doc: <TASKS_HOME>/<id>/**.md
                                                        (or <project>/.claude/tasks/ABC-XXXX/*.md)
- TaskFolder { path, id, aliases, repos, branches,
               worktrees, present, deletedAt }         — <TASKS_HOME>/<id>/ (meta.json). id = Jira key
                                                        or provisional (worktree name); aliases = old ids.
                                                        present=false after tasks:gc deleted it (content stays)
- PullRequest { key 'repo#n', repo, number, title, url,
                state OPEN|MERGED|CLOSED, branch,
                createdAt, mergedAt, closedAt }        — sync:prs (gh), found by key in title or branch
- RepoDoc { key 'repo:path', repo, path, sha, author,
            updatedAt, removed }                       — markdown committed on the repo default branch
- ResearchDoc { path, title, createdAt }              — <RESEARCH_HOME>/**.md, never deleted

## Edges
- (Project)-[:HAS_SESSION]->(Session)
- (Session)-[:HAS_MESSAGE]->(Message)
- (Message)-[:REPLIES_TO]->(Message)        — via parentUuid
- (Message)-[:HAS_CHUNK]->(Chunk)
- (Message)-[:INVOKED]->(ToolCall)
- (ToolCall)-[:HAS_CHUNK]->(Chunk)          — only when tool output < 2k chars
- (Plan)-[:HAS_CHUNK]->(Chunk)
- (TaskMemoryDoc)-[:HAS_CHUNK]->(Chunk)
- (Project)-[:HAS_TASK_MEMORY]->(TaskMemoryDoc)
- (Session)-[:ON_TASK]->(Task)            — task da branch da sessão
- (Chunk)-[:MENTIONS_TASK]->(Task)        — task citada no texto
- (Session)-[:WROTE|READ]->(File)         — arquivo mudado / lido
- (Task)-[:TOUCHES]->(File)               — derivada, responde trabalho relacionado em 1 hop
- (Task)-[:IN_PROJECT]->(Project)
- (Plan)-[:PLANNED_IN]->(Session), (Plan)-[:ABOUT_TASK]->(Task), (Project)-[:HAS_PLAN]->(Plan)
- (TaskMemoryDoc)-[:ABOUT_TASK]->(Task), (TaskFolder)-[:FOR_TASK]->(Task)
- (PullRequest)-[:FOR_TASK]->(Task), (PullRequest)-[:REPLACES]->(PullRequest) — newer PR after a closed one, same task+repo
- (Session)-[:WORKED_ON_PR]->(PullRequest) — session on the PR branch
- (ToolCall:tool_result)-[:RESULT_OF { pairedBy: id|position }]->(ToolCall) — result -> request
- (Session)-[:USED_SKILL { toolCount, slashCount, firstAt, lastAt }]->(Skill)
- (Session)-[:USED_AGENT { count, firstAt }]->(AgentType), (Task)-[:USES_SKILL { sessions }]->(Skill)
- (Message)-[:CORRECTS]->(ToolCall|Message)  — user correction -> the step it corrects
- (Decision { source: 'correction', correctionCount, coveredBySkill, coveredAt })-[:FROM_CORRECTION]->(Message),
  (Decision)-[:ABOUT_SKILL]->(Skill) — rule distilled from a correction repeated in 2+ sessions
- (Skill)-[:HAS_CHUNK]->(Chunk { sourceKind: 'skill_doc' })
- (Project)-[:HAS_DOC]->(RepoDoc), (RepoDoc|ResearchDoc|PullRequest)-[:HAS_CHUNK]->(Chunk)
- (Task)-[:PART_OF {source, confidence, unit, at}]->(Task:Epic|Story)
  source = prompt (linha [task] do fluxo "analise KEY") | haiku | regex; 1 pai por task.
  Irmãs (filhas do mesmo pai não-balde) são a ponte entre repos: back e front da mesma feature.
- (Task:Epic)-[:RELATES {source}]->(Task)  — epic que continua/se relaciona com outro (V1/V2, antecessor)
- (Decision)-[:HAS_CHUNK]->(Chunk), (Decision)-[:FROM_SESSION]->(Session)
- (Decision)-[:ON_TASK]->(Task), (Decision)-[:ABOUT]->(File)
- (Chunk)-[:SIMILAR_TO {score, computedAt}]->(Chunk)
  precomputed cross-chunk semantic neighbors (top-3, threshold>=0.75)
  use traversal via find_similar_chunks tool (no re-embed)

## Vector index
chunks_embedding  ON  (c:Chunk) ON (c.embedding)
  vector.dimensions = 1024
  vector.similarity_function = 'cosine'

## Fulltext index
chunks_text  ON  (c:Chunk) ON EACH [c.text]
  Lucene-based BM25
  used by hybrid scoring in search_memory / find_related_plans / find_decisions

## Hybrid retrieval scoring
BM25 only when the query has literal tokens (ABC-1234, path.ext, camelCase,
snake_case, CONST_CASE, ACRONYM, 1.2.3). Recall pool = union of vector top-500,
BM25 top-500 and chunks of sessions linked to a task named in the query.
Ranking = RRF (k=60) over the lists x learned boosts, then MMR (diversity).
Sessions of epic sibling tasks (of the task named in the query or of the
caller's branch task) get a weak boost (1.2) in MMR: cross-repo work of the
same feature surfaces without crowding the task's own sessions.
Output is brief by default; expand_hits(ids) returns full text.

## sourceKind values on Chunk
- conversation   — user/assistant message text
- plan           — ~/.claude/plans markdown
- decision       — distilled decision/rule/gotcha/finding (<=300 chars), parent node Decision
- task_memory    — task folder doc (<TASKS_HOME>/<id>/*.md or <repo>/.claude/tasks), parent TaskMemoryDoc
- research       — saved research note (<RESEARCH_HOME>/**.md), parent ResearchDoc
- pr             — pull request title + description, parent PullRequest (FOR_TASK -> Task)
- repo_doc       — markdown committed on the repo default branch, parent RepoDoc (author, updatedAt)
- skill_doc      — installed skill/command text, parent Skill. Excluded from search_memory unless
                   scope asks for it; used to check whether a distilled rule is already in a skill
(Todo is stored as node, not embedded; tool outputs are ToolCall nodes, not embedded)

## Reading the numbers (how to decide whether to cite)
- confidence (conf=, 0..1): percentile of the hit's vector similarity against the historical
  distribution. Comparable across queries: it is the ONLY number that decides citing.
  null / "conf n/a" = local calibration still collecting samples: never treat a hit as strong.
- score: RRF fusion, only orders hits inside the SAME query. bge-m3 returns cosine 0.86-0.91
  for almost anything, so no absolute cut on score works (0.70 approves 100%, junk included).
- header pool=N vec_med=X: similarity floor of that query; a hit near the median is noise.
- Cutoffs STRONG / FLOOR come from the recall benchmark (bench:recall): STRONG = lowest
  confidence where 80% of hits are truly relevant, FLOOR = 50%. Bench older than 14 days falls
  back to p75/p25 of the best hit per query (a quota that drifts). Current values: the
  "gate de citação" line of the session primer. Fallback without it: STRONG 0.90, FLOOR 0.59.
- Query tips: an abstract topic plus domain ("feature flag rollout laravel") recalls better
  than single words ("flag"); generic topics ("react") bring noise. Brief output + expand_hits
  costs a fraction of detail:'full'. diversity 0.3 = panorama across sessions, 0.9 = focus on
  one topic (>= 0.9 also lifts the 1-hit-per-session cap). "More conversations like this hit":
  find_similar_chunks({ chunkId }) instead of a new search.

## Retention
Claude Code prunes transcripts after cleanupPeriodDays (90 by default). The graph is the only
record of pruned sessions, so an ingest gap longer than that is permanent loss.

## Useful Cypher

# top 10 chunks for embedding (when you have the query vector):
CALL db.index.vector.queryNodes('chunks_embedding', 10, $vec)
YIELD node, score
RETURN node.text, node.sourceKind, score

# all sessions in a project ordered by date:
MATCH (p:Project { path: $cwd })-[:HAS_SESSION]->(s:Session)
RETURN s.id, s.startedAt, s.gitBranch ORDER BY s.startedAt DESC

# decisions of a task and of its siblings under the same epic (other repos):
MATCH (t:Task { key: 'ABC-123' })-[:PART_OF]->(e:Task) WHERE NOT coalesce(e.bucket, false)
MATCH (e)<-[:PART_OF]-(sib:Task)<-[:ON_TASK]-(d:Decision { status: 'active' })
RETURN sib.key, d.repo, d.kind, d.text
(or just: find_decisions({ taskId: 'ABC-123' }) / recall_task({ taskKey: 'ABC-123' }))
`;

export function registerSchemaResource(server: McpServer): void {
  server.registerResource(
    'memory://schema',
    'memory://schema',
    {
      description:
        'Reference: nodes, edges, vector index, sourceKind values and useful Cypher queries for the indexed memory.',
    },
    async () => ({
      contents: [
        {
          uri: 'memory://schema',
          mimeType: 'text/markdown',
          text: `${await liveInventory()}\n\n${SCHEMA_DOC}`,
        },
      ],
    }),
  );
}
