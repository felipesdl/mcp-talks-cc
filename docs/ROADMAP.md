# Roadmap — evolução do loop de aprendizado

Estado atual (v2): query log → grading auto-supervisionado (echo/reformulação/drill-in) →
profile → primer (push no SessionStart) → tuner coadjuvante (propõe boosts bounded, user
aprova com `npm run self-tune:accept`, ou recusa com `npm run self-tune:reject`). `project` é
soft boost no ranking, score reportado fica raw.

O tuner só propõe com a calibração de echo pronta. Sem ela todo credit por hit é 0 por
construção (`applyCalibration` devolve null, `grade.ts` cai no `?? 0`), e `1 + 0.3 * (0 -
meanUtility)` transformava zero estrutural em penalidade nas fontes mais usadas — medido em
2026-08-24: 198 hitCredits todos 0 propondo 0.936 em `conversation`/`px-painel`.

**Atualização 2026-09-29 (v3):** as duas evoluções abaixo foram construídas, com uma mudança
de premissa. A distilação não espera mais grade: seleciona por estrutura (sessão fechada com
entrega), porque com ~40 buscas/mês o pré-requisito "grades suficientes" nunca fechava. O push
saiu como ponteiro de 1 linha (não conteúdo), com o gate derivado de um gabarito de recall
(`bench:recall`) em vez de percentil. Ver README, seções Push, Distilação e Medição.

Medido no bench:recall (37 casos com resposta) + bench de task (151 tasks), contra o código
real da main no mesmo grafo:

| | main | v3 |
|---|---|---|
| recall@8 prosa | 73.0% | 89.2% |
| MRR prosa | 0.609 | 0.716 |
| ruído (hit na mediana do pool) | 17.0% | 13.2% |
| tokens por busca (o que o Claude recebe) | ~3.5k | ~450 |
| task hit@8 / narração | 99.3% / 8.3% | 100% / 8.0% |

O ganho de ranking veio de normalizar a relevância no modo vetorial (o cosseno cru tem ~0.04 de
spread e os boosts atropelavam a similaridade) e do teto de 1 hit por sessão (exceto sessões da
task citada na query). Decisions destiladas não mudaram o recall por sessão; o valor delas é
densidade (regra de ~50 tokens), primer e ponteiro de arquivo.

**Testado e descartado:** chunk por turno (pergunta humana + entrega num chunk só, 3.4k chunks).
Recall e MRR idênticos, ruído 13.2% -> 12.9%. Sem ganho que pague o índice maior e o passo a mais
no ingest.

Texto original abaixo, pelo histórico da decisão.

## 1. Distilação (maior ganho previsto)

Passo no self-tune que extrai das conversas de ALTA utilidade (grading já identifica quais)
nós curados `Rule` / `Decision` no grafo:

- exemplo: "validação de email usa regex X, vale em web-app e api-core"
- busca privilegia nós destilados (boost de sourceKind novo `rule`)
- primer lista as top rules em vez de gists de query
- economia: 1 regra destilada de ~50 tokens > 3 chunks de transcript de ~400 tokens

Pré-requisito: grades.jsonl com volume suficiente pra saber quais conversas valem distilar.
Extração pode usar LLM (claude -p batch) ou heurística sobre chunks de alta utility.

## 2. Push por prompt (UserPromptSubmit hook)

Hook que roda search_memory na mensagem do user e injeta o top hit como contexto quando o
score passa do threshold. A memória chega sem o modelo decidir chamar a tool.

- custo: ~200-500ms por prompt (embedding local) + risco de ruído no contexto
- **gate de decisão**: construir SÓ se, depois de ~2 semanas com primer + CLAUDE.md firme,
  o query-log mostrar uso ainda baixo de search_memory. O grading mede se o push ajudou
  (echo/drill-in sobre os hits injetados).

## Ordem de valor (se precisar cortar)

query log > primer > grading > profile > boosts per-source/per-project > qualquer tuning
de lambda/pesos.
