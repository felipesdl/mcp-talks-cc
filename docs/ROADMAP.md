# Roadmap — evolução do loop de aprendizado

Estado atual (v2): query log → grading auto-supervisionado (echo/reformulação/drill-in) →
profile → primer (push no SessionStart) → tuner coadjuvante (propõe boosts bounded, user
aprova com `npm run self-tune:accept`). `project` é soft boost no ranking, score reportado
fica raw.

As duas evoluções abaixo foram decididas mas NÃO construídas: ambas dependem do loop de
medição rodando primeiro.

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
