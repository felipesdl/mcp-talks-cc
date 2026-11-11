import type { Session } from 'neo4j-driver';
import { z } from 'zod';
import { runHeadless } from './headless.ts';

/**
 * Regra a partir de correção repetida, em 3 etapas com Haiku:
 *   1. cada correção forte vira a regra implícita dela (ou null, se é pontual);
 *   2. regras de mesmo sentido são agrupadas e a final é redigida;
 *   3. um juiz diz se a regra já está escrita nas skills (3 trechos mais próximos).
 * Agrupar pelo embedding do texto cru não funciona com bge-m3 (medido em
 * 10/11/2026: corte 0.85 junta assunto sem relação, 0.90+ só junta texto
 * idêntico). Regra que se repete em 2+ sessões e não está em skill nenhuma é o
 * caso que a memória sozinha não resolve.
 */

export interface CorrectionItem {
  uuid: string;
  sessionId: string;
  ts: string;
  text: string;
  /** Skill ou tool do passo corrigido. */
  target: string | null;
}


export function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

// ── Etapa 1: regra implícita por correção (Haiku, em lote) ──────────────────

const EXTRACT_SCHEMA = {
  type: 'object',
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: { n: { type: 'integer' }, rule: { type: ['string', 'null'] } },
        required: ['n', 'rule'],
      },
    },
  },
  required: ['items'],
};

const EXTRACT_SYSTEM = `Cada linha é uma mensagem que um usuário mandou ao assistente (Claude Code) logo depois de um passo do assistente (skill ou ferramenta indicada entre colchetes). Pra cada linha, diga a REGRA implícita que o assistente deveria seguir pra não precisar dessa correção, ou null se a mensagem não ensina nada reutilizável (pergunta pontual, mudança de ideia, pedido novo, ajuste só daquela tarefa).

rule: pt-BR, uma frase curta e canônica (máx 160 caracteres), nomeando a skill/ferramenta/comando concreto. Ex.: "Pra rodar os testes usar npm run test:unit, não npx jest direto". Sem travessão. Responda todas as linhas pelo número n.`;

export async function extractImpliedRules(items: CorrectionItem[]): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  for (let i = 0; i < items.length; i += 25) {
    const batch = items.slice(i, i + 25);
    const input = batch.map((m, k) => `${k + 1}. [${m.target ?? '?'}] ${m.text.slice(0, 400).replace(/\s+/g, ' ')}`).join('\n');
    const raw = (await runHeadless({ system: EXTRACT_SYSTEM, schema: EXTRACT_SCHEMA, input, timeoutMs: 180_000 })) as {
      items: Array<{ n: number; rule: string | null }>;
    };
    for (const r of raw.items ?? []) {
      const m = batch[r.n - 1];
      if (m) out.set(m.uuid, r.rule && r.rule.trim().length >= 10 ? r.rule.trim().slice(0, 200) : null);
    }
    for (const m of batch) if (!out.has(m.uuid)) out.set(m.uuid, null);
  }
  return out;
}

// ── Etapa 2: agrupar regras de mesmo sentido e redigir a final ──────────────

const groupSchema = z.object({
  groups: z.array(
    z.object({
      members: z.array(z.number().int()),
      text: z.string().min(15).max(400),
      scope: z.enum(['repo', 'cross']),
      skill: z.string().nullable(),
      where: z.enum(['skill', 'claude_md', 'rules']),
    }),
  ),
});
export type RuleGroup = z.infer<typeof groupSchema>['groups'][number];

const GROUP_JSON_SCHEMA = {
  type: 'object',
  properties: {
    groups: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          members: { type: 'array', items: { type: 'integer' } },
          text: { type: 'string', maxLength: 300 },
          scope: { type: 'string', enum: ['repo', 'cross'] },
          skill: { type: ['string', 'null'] },
          where: { type: 'string', enum: ['skill', 'claude_md', 'rules'] },
        },
        required: ['members', 'text', 'scope', 'skill', 'where'],
      },
    },
  },
  required: ['groups'],
};

const GROUP_SYSTEM = `Cada linha é uma regra extraída de uma correção que o MESMO usuário fez ao assistente. Agrupe as linhas que dizem a MESMA regra (mesmo comportamento esperado), mesmo com palavras diferentes. Devolva só grupos com 2 ou mais linhas; regra que aparece uma vez fica de fora.

Pra cada grupo: members (números das linhas); text = a regra final, pt-BR, imperativa, autocontida, máx 300 caracteres, sem travessão; skill = nome exato da skill a que se aplica, ou null; where = onde deveria morar pra ser seguida sempre ("skill": description/corpo de uma skill; "claude_md": instrução geral; "rules": roteamento entre skills/ferramentas); scope = "cross" se vale em qualquer repo, "repo" se é de um só.`;

export async function groupRules(rules: string[]): Promise<RuleGroup[]> {
  if (rules.length < 2) return [];
  const input = rules.map((r, i) => `${i + 1}. ${r}`).join('\n');
  const raw = await runHeadless({ system: GROUP_SYSTEM, schema: GROUP_JSON_SCHEMA, input, timeoutMs: 240_000 });
  return groupSchema.parse(raw).groups.map((g) => ({ ...g, members: g.members.map((n) => n - 1).filter((n) => n >= 0 && n < rules.length) }));
}

// ── Etapa 3: a regra já está escrita em alguma skill? ───────────────────────

const COVER_SCHEMA = {
  type: 'object',
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: { n: { type: 'integer' }, covered: { type: 'boolean' }, skill: { type: ['string', 'null'] } },
        required: ['n', 'covered', 'skill'],
      },
    },
  },
  required: ['items'],
};

const COVER_SYSTEM = `Pra cada regra numerada vêm trechos de skills (instruções que o assistente lê). Diga se a regra JÁ ESTÁ dita nos trechos de forma que um assistente lendo seguiria (covered=true, e skill = nome da skill que a cobre), ou se não está (covered=false, skill=null). Trecho que só fala do mesmo assunto sem dizer a regra não cobre.`;

export async function judgeCoverage(
  rules: Array<{ text: string; candidates: Array<{ skill: string; text: string }> }>,
): Promise<Array<{ covered: boolean; skill: string | null }>> {
  if (rules.length === 0) return [];
  const input = rules
    .map((r, i) => `${i + 1}. REGRA: ${r.text}\n${r.candidates.map((c) => `   [${c.skill}] ${c.text.slice(0, 600).replace(/\s+/g, ' ')}`).join('\n')}`)
    .join('\n\n');
  const raw = (await runHeadless({ system: COVER_SYSTEM, schema: COVER_SCHEMA, input, timeoutMs: 240_000 })) as {
    items: Array<{ n: number; covered: boolean; skill: string | null }>;
  };
  const byN = new Map((raw.items ?? []).map((x) => [x.n, x]));
  return rules.map((_, i) => ({ covered: byN.get(i + 1)?.covered ?? false, skill: byN.get(i + 1)?.skill ?? null }));
}

/** Os k trechos de skill mais próximos da regra (candidatos pro juiz). */
export function topSkillChunks(
  ruleVec: number[],
  chunks: Array<{ skill: string; vec: number[]; text: string }>,
  k = 3,
): Array<{ skill: string; text: string; score: number }> {
  return chunks
    .map((c) => ({ skill: c.skill, text: c.text, score: cosine(ruleVec, c.vec) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, k);
}

/** Mesmo texto (normalizado) conta uma vez: sessão retomada copia as mensagens. */
export function dedupeByText(items: CorrectionItem[]): CorrectionItem[] {
  const seen = new Set<string>();
  return items
    .sort((a, b) => a.ts.localeCompare(b.ts))
    .filter((m) => {
      const k = m.text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim().slice(0, 120);
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
}

export async function loadCorrections(s: Session): Promise<CorrectionItem[]> {
  const r = await s.run(`MATCH (se:Session)-[:HAS_MESSAGE]->(m:Message { correction: 'strong' })
    OPTIONAL MATCH (m)-[:CORRECTS]->(tc:ToolCall)
    RETURN m.uuid AS uuid, se.id AS sid, m.timestamp AS ts, m.correctionText AS text,
           coalesce(tc.skill, tc.name) AS target`);
  const items = r.records
    .map((x) => ({
      uuid: x.get('uuid') as string,
      sessionId: x.get('sid') as string,
      ts: (x.get('ts') as string) ?? '',
      text: ((x.get('text') as string) ?? '').trim(),
      target: x.get('target') as string | null,
    }))
    .filter((x) => x.text.length >= 8);
  return items;
}

export async function loadSkillChunks(s: Session): Promise<Array<{ skill: string; vec: number[]; text: string }>> {
  const r = await s.run(`MATCH (k:Skill)-[:HAS_CHUNK]->(c:Chunk { sourceKind: 'skill_doc' }) WHERE c.embedding IS NOT NULL
    RETURN k.name AS skill, c.embedding AS vec, c.text AS text`);
  return r.records.map((x) => ({ skill: x.get('skill') as string, vec: x.get('vec') as number[], text: x.get('text') as string }));
}
