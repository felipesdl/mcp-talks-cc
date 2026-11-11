import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Session } from 'neo4j-driver';
import { config } from '../config.ts';

/**
 * Métricas de fluxo por semana (segunda a domingo), a partir do grafo e do
 * query-log. É a série que mostra se capturar skill/erro/correção, a tool
 * my_flow e as regras destiladas de correção mudaram alguma coisa no trabalho.
 */

export interface WeekRow {
  week: string;
  prompts: number;
  corrStrong: number;
  corrWeak: number;
  implSessions: number;
  taskSessions: number;
  rejections: number;
  errors: number;
  compactions: number;
  mergedTasks: number;
  sessionsOfMergedTasks: number;
  myFlowCalls: number;
  recallTaskCalls: number;
  adoptionSessions: number;
  recurrences: number;
}

/** Segunda-feira da semana de uma data `AAAA-MM-DD`. */
export function weekOf(day: string): string {
  const d = new Date(`${day.slice(0, 10)}T00:00:00Z`);
  const dow = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - dow);
  return d.toISOString().slice(0, 10);
}

const HARNESS = `coalesce(m.sidechain, false) = false AND NOT m.text STARTS WITH 'Base directory for this skill'
  AND NOT m.text STARTS WITH '<' AND NOT m.text STARTS WITH 'This session is being continued'
  AND NOT m.text STARTS WITH '[Request interrupted' AND NOT m.text STARTS WITH 'Another Claude session'
  AND NOT m.text STARTS WITH 'Caveat:'`;

async function byDay(s: Session, cypher: string, params: Record<string, unknown> = {}): Promise<Map<string, number>> {
  const r = await s.run(cypher, params);
  const out = new Map<string, number>();
  for (const x of r.records) {
    const d = x.get('d') as string | null;
    if (!d) continue;
    const w = weekOf(d);
    out.set(w, (out.get(w) ?? 0) + Number(x.get('n')));
  }
  return out;
}

export async function computeWeekly(s: Session): Promise<WeekRow[]> {
  const prompts = await byDay(
    s,
    `MATCH (m:Message { role: 'user' }) WHERE size(m.text) > 2 AND ${HARNESS}
     RETURN left(m.timestamp, 10) AS d, count(*) AS n`,
  );
  const corrStrong = await byDay(s, `MATCH (m:Message { correction: 'strong' }) RETURN left(m.timestamp, 10) AS d, count(*) AS n`);
  const corrWeak = await byDay(s, `MATCH (m:Message { correction: 'weak' }) RETURN left(m.timestamp, 10) AS d, count(*) AS n`);
  const impl = await byDay(s, `MATCH (se:Session { kind: 'implementation' }) RETURN left(se.startedAt, 10) AS d, count(*) AS n`);
  const taskSess = await byDay(s, `MATCH (se:Session) WHERE (se)-[:ON_TASK]->() RETURN left(se.startedAt, 10) AS d, count(*) AS n`);
  const rejections = await byDay(
    s,
    `MATCH (tc:ToolCall { name: 'tool_result', errorKind: 'rejected' }) RETURN left(tc.timestamp, 10) AS d, count(*) AS n`,
  );
  const errors = await byDay(
    s,
    `MATCH (tc:ToolCall { name: 'tool_result' }) WHERE tc.isError = true AND tc.errorKind <> 'rejected'
     RETURN left(tc.timestamp, 10) AS d, count(*) AS n`,
  );
  const compactions = await byDay(
    s,
    `MATCH (m:Message { role: 'user' }) WHERE m.text STARTS WITH 'This session is being continued'
     RETURN left(m.timestamp, 10) AS d, count(*) AS n`,
  );
  // Task terminada na semana (último PR mergeado): quantas sessões custou.
  const merged = await s.run(`MATCH (t:Task)<-[:FOR_TASK]-(pr:PullRequest)
    WITH t, collect(pr.state) AS st, max(pr.mergedAt) AS m WHERE all(x IN st WHERE x = 'MERGED') AND m IS NOT NULL
    OPTIONAL MATCH (t)<-[:ON_TASK]-(se:Session)
    WITH t, m, count(DISTINCT se) AS n
    RETURN left(m, 10) AS d, n`);
  const mergedTasks = new Map<string, number>();
  const sessOfMerged = new Map<string, number>();
  for (const x of merged.records) {
    const w = weekOf(x.get('d') as string);
    mergedTasks.set(w, (mergedTasks.get(w) ?? 0) + 1);
    sessOfMerged.set(w, (sessOfMerged.get(w) ?? 0) + Number(x.get('n')));
  }
  // Correção que reincide depois de a regra estar coberta por skill.
  const recurrences = await byDay(
    s,
    `MATCH (d:Decision { source: 'correction' })-[:FROM_CORRECTION]->(m:Message)
     WHERE d.coveredAt IS NOT NULL AND m.timestamp > d.coveredAt
     RETURN left(m.timestamp, 10) AS d, count(*) AS n`,
  );

  // Uso de tools pelo query-log (my_flow e recall_task só logam da v0.6 pra frente).
  const myFlow = new Map<string, number>();
  const recall = new Map<string, number>();
  const adoptBySession = new Map<string, string>();
  const raw = await readFile(join(config.paths.cacheDir, 'query-log.jsonl'), 'utf8').catch(() => '');
  for (const line of raw.split('\n')) {
    if (!line) continue;
    try {
      const e = JSON.parse(line) as { ts?: string; tool?: string; sessionId?: string | null };
      if (!e.ts || (e.tool !== 'my_flow' && e.tool !== 'recall_task')) continue;
      const w = weekOf(e.ts);
      const m = e.tool === 'my_flow' ? myFlow : recall;
      m.set(w, (m.get(w) ?? 0) + 1);
      if (e.sessionId) adoptBySession.set(e.sessionId, w);
    } catch {
      // linha quebrada
    }
  }
  const adoption = new Map<string, number>();
  if (adoptBySession.size > 0) {
    const r = await s.run(`UNWIND $ids AS id MATCH (se:Session { id: id }) WHERE (se)-[:ON_TASK]->()
      RETURN left(se.startedAt, 10) AS d, count(*) AS n`, { ids: [...adoptBySession.keys()] });
    for (const x of r.records) {
      const w = weekOf(x.get('d') as string);
      adoption.set(w, (adoption.get(w) ?? 0) + Number(x.get('n')));
    }
  }

  const weeks = new Set<string>([...prompts.keys(), ...impl.keys()]);
  return [...weeks].sort().map((week) => ({
    week,
    prompts: prompts.get(week) ?? 0,
    corrStrong: corrStrong.get(week) ?? 0,
    corrWeak: corrWeak.get(week) ?? 0,
    implSessions: impl.get(week) ?? 0,
    taskSessions: taskSess.get(week) ?? 0,
    rejections: rejections.get(week) ?? 0,
    errors: errors.get(week) ?? 0,
    compactions: compactions.get(week) ?? 0,
    mergedTasks: mergedTasks.get(week) ?? 0,
    sessionsOfMergedTasks: sessOfMerged.get(week) ?? 0,
    myFlowCalls: myFlow.get(week) ?? 0,
    recallTaskCalls: recall.get(week) ?? 0,
    adoptionSessions: adoption.get(week) ?? 0,
    recurrences: recurrences.get(week) ?? 0,
  }));
}

/** Resumo das últimas 4 semanas completas (a semana corrente fica de fora). */
export function summarize(weeks: WeekRow[], now = new Date()): Record<string, number | string | null> {
  const current = weekOf(now.toISOString());
  const win = weeks.filter((w) => w.week < current).slice(-4);
  const sum = (k: keyof WeekRow): number => win.reduce((a, w) => a + Number(w[k]), 0);
  const ratio = (a: number, b: number, mult = 1): number | null => (b === 0 ? null : Math.round((mult * a * 100) / b) / 100);
  return {
    janela: win.length ? `${win[0]!.week}..${win[win.length - 1]!.week}` : null,
    prompts: sum('prompts'),
    correcoesFortesPor100Prompts: ratio(sum('corrStrong'), sum('prompts'), 100),
    correcoesFracasPor100Prompts: ratio(sum('corrWeak'), sum('prompts'), 100),
    recusasPorSessaoImpl: ratio(sum('rejections'), sum('implSessions')),
    errosPorSessaoImpl: ratio(sum('errors'), sum('implSessions')),
    sessoesPorTaskMergeada: ratio(sum('sessionsOfMergedTasks'), sum('mergedTasks')),
    compactacoesPor100Prompts: ratio(sum('compactions'), sum('prompts'), 100),
    usosMyFlow: sum('myFlowCalls'),
    usosRecallTask: sum('recallTaskCalls'),
    adocaoSessoesDeTaskPct: ratio(sum('adoptionSessions'), sum('taskSessions'), 100),
    reincidencias: sum('recurrences'),
  };
}
