import { basename } from 'node:path';
import { LITERAL_TOKEN_RE } from '../mcp/tools/searchMemory.ts';
import type { Grade, Profile, QueryLogEntry } from './types.ts';

const STOPWORDS = new Set([
  // pt
  'que', 'com', 'para', 'pra', 'uma', 'por', 'mais', 'como', 'dos', 'das', 'tem',
  'foi', 'ser', 'sobre', 'qual', 'quais', 'quando', 'onde', 'isso', 'esse', 'essa',
  'este', 'esta', 'são', 'nao', 'não', 'sim', 'mas', 'tipo', 'fazer', 'feito',
  // en
  'the', 'and', 'for', 'with', 'that', 'this', 'how', 'what', 'when', 'where',
  'from', 'are', 'was', 'were', 'has', 'have', 'had', 'can', 'use', 'using', 'used',
]);

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9à-ú_/.-]+/i)
    .filter((t) => t.length >= 3 && !STOPWORDS.has(t));
}

/** TF-IDF barato sobre queries graded, ponderado por utility×confidence. */
function rankTopics(graded: Array<{ entry: QueryLogEntry; grade: Grade }>, top: number): string[] {
  const docFreq = new Map<string, number>();
  const weight = new Map<string, number>();
  for (const { entry, grade } of graded) {
    if (!entry.query) continue;
    const tokens = new Set(tokenize(entry.query));
    for (const tok of tokens) {
      docFreq.set(tok, (docFreq.get(tok) ?? 0) + 1);
      weight.set(tok, (weight.get(tok) ?? 0) + grade.utility * grade.confidence + 0.1);
    }
  }
  const n = Math.max(1, graded.length);
  return [...weight.entries()]
    .map(([tok, w]) => ({ tok, score: w * Math.log(1 + n / (docFreq.get(tok) ?? 1)) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, top)
    .map((x) => x.tok);
}

function median(values: number[]): number {
  if (values.length === 0) return 8;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
}

/** Clusters por co-ocorrência de projectPath nos hits da mesma query (>=3 co-ocorrências). */
function clusterProjects(entries: QueryLogEntry[]): string[][] {
  const pairCount = new Map<string, number>();
  for (const e of entries) {
    const projects = [...new Set(e.hits.map((h) => h.project).filter((p): p is string => !!p))];
    for (let i = 0; i < projects.length; i++) {
      for (let j = i + 1; j < projects.length; j++) {
        const key = [projects[i], projects[j]].sort().join('|');
        pairCount.set(key, (pairCount.get(key) ?? 0) + 1);
      }
    }
  }
  // union-find simples sobre pares frequentes
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    if (parent.get(x) !== x) parent.set(x, find(parent.get(x)!));
    return parent.get(x)!;
  };
  for (const [key, count] of pairCount) {
    if (count < 3) continue;
    const [a, b] = key.split('|') as [string, string];
    if (!parent.has(a)) parent.set(a, a);
    if (!parent.has(b)) parent.set(b, b);
    parent.set(find(a), find(b));
  }
  const clusters = new Map<string, string[]>();
  for (const node of parent.keys()) {
    const root = find(node);
    clusters.set(root, [...(clusters.get(root) ?? []), node]);
  }
  return [...clusters.values()].filter((c) => c.length >= 2);
}

export function buildProfile(
  graded: Array<{ entry: QueryLogEntry; grade: Grade }>,
  windowDays: number,
): Profile {
  const searchGraded = graded.filter((g) => g.entry.tool === 'search_memory');

  // utility por hit (credit × confidence), agregada por projeto e sourceKind
  const byProject = new Map<string, { sum: number; n: number }>();
  const bySource = new Map<string, { sum: number; n: number }>();
  let totalHits = 0;
  for (const { entry, grade } of searchGraded) {
    const credits = new Map(grade.hitCredits.map((c) => [c.id, c.credit]));
    for (const hit of entry.hits) {
      totalHits++;
      const credit = (credits.get(hit.id) ?? 0) * grade.confidence;
      if (hit.project) {
        const p = byProject.get(hit.project) ?? { sum: 0, n: 0 };
        p.sum += credit;
        p.n++;
        byProject.set(hit.project, p);
      }
      const sk = bySource.get(hit.source) ?? { sum: 0, n: 0 };
      sk.sum += credit;
      sk.n++;
      bySource.set(hit.source, sk);
    }
  }

  const topProjects = [...byProject.entries()]
    .map(([path, { sum, n }]) => ({
      path,
      name: basename(path),
      share: totalHits > 0 ? n / totalHits : 0,
      meanUtility: n > 0 ? sum / n : 0,
    }))
    .sort((a, b) => b.share - a.share)
    .slice(0, 5);

  const sourceKindUtility: Profile['sourceKindUtility'] = {};
  for (const [source, { sum, n }] of bySource) {
    sourceKindUtility[source] = { meanUtility: n > 0 ? sum / n : 0, n };
  }

  const queries = searchGraded.map((g) => g.entry.query).filter((q): q is string => !!q);
  const literalCount = queries.filter((q) => {
    LITERAL_TOKEN_RE.lastIndex = 0;
    return LITERAL_TOKEN_RE.test(q);
  }).length;

  const termCount = new Map<string, number>();
  for (const q of queries) {
    LITERAL_TOKEN_RE.lastIndex = 0;
    for (const m of q.matchAll(LITERAL_TOKEN_RE)) {
      const tok = m[0];
      if (!STOPWORDS.has(tok.toLowerCase())) termCount.set(tok, (termCount.get(tok) ?? 0) + 1);
    }
  }
  const terminology = [...termCount.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15)
    .map(([tok]) => tok);

  const zeroHitTerms = [
    ...new Set(
      searchGraded
        .filter((g) => g.grade.signals.zeroHit && g.entry.query)
        .flatMap((g) => tokenize(g.entry.query!)),
    ),
  ].slice(0, 10);

  const recentHighValue = searchGraded
    .filter((g) => g.grade.utility * g.grade.confidence >= 0.4 && g.entry.query)
    .sort((a, b) => b.entry.ts.localeCompare(a.entry.ts))
    .slice(0, 5)
    .map((g) => {
      const topHit = g.entry.hits[0];
      return {
        gist: g.entry.query!.slice(0, 120),
        when: g.entry.ts.slice(0, 10),
        ref: topHit?.sessionId ? `session:${topHit.sessionId}` : (topHit ? `chunk:${topHit.id}` : '-'),
      };
    });

  const gradedCount = searchGraded.length;
  const meanUtility =
    gradedCount > 0
      ? searchGraded.reduce((acc, g) => acc + g.grade.utility * g.grade.confidence, 0) /
        Math.max(0.001, searchGraded.reduce((acc, g) => acc + g.grade.confidence, 0))
      : 0;

  return {
    v: 1,
    generatedAt: new Date().toISOString(),
    windowDays,
    topProjects,
    projectClusters: clusterProjects(searchGraded.map((g) => g.entry)),
    recurringTopics: rankTopics(searchGraded, 8),
    terminology,
    sourceKindUtility,
    queryShapes: {
      zeroHitTerms,
      medianK: median(searchGraded.map((g) => g.entry.k ?? 8)),
      literalVsNL: { lit: literalCount, nl: queries.length - literalCount },
    },
    recentHighValue,
    lastEval: {
      ranAt: new Date().toISOString(),
      queriesGraded: gradedCount,
      meanUtility,
      healthy: gradedCount === 0 || meanUtility > 0.2,
    },
  };
}
