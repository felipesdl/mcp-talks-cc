# Changelog

Toda versão nova: `git pull` e abrir uma sessão nova do Claude Code. O primer detecta que o
repo está à frente da instalação e o Claude pergunta na primeira resposta:

- **Atualizar agora**: ele roda `npm run upgrade`, mostra o diff do bloco de memória e pergunta
  se aplica no seu `~/.claude/CLAUDE.md` (com backup). Nada no CLAUDE.md muda sem o seu ok.
- Em seguida ele explica a **distilação automática** (o que é, por que vale, quanto custa) e
  pergunta se liga. A resposta fica no `.env` (`MCP_TALKS_DISTILL=1` ou `=0`) e não é perguntada
  de novo; muda com `npm run upgrade -- --distill=on|off`.
- **Agora não**: adia 3 dias (`npm run upgrade -- --snooze[=DIAS]`).

Sem o Claude: `npm run upgrade` e `npm run upgrade:claude-md -- --dry-run | --apply`. Tudo idempotente.

Convenção: **patch** (0.3.x) não tem passo de upgrade e não gera pergunta; o código vale no
`git pull`. **Minor** (0.x.0) pode ter migração e dispara a pergunta de atualização.

## Não lançado (0.5.0)

- **Skill, erro de tool e correção como entidade.** Pareamento pedido -> resultado (`RESULT_OF`),
  `isError`/`errorKind`, skill e subagente por chamada, slash command e `sidechain` por mensagem,
  `USED_SKILL`/`USED_AGENT` por sessão e `USES_SKILL` por task, catálogo das skills instaladas
  (`--source=skills`), correções do usuário (`Message.correction`, `CORRECTS`). Reparse sem
  re-embedar: `npm run ingest -- --source=conversations --reparse`.
- **`my_flow`**: o fluxo típico pra um tipo de task (cadeia de skills, onde quebra, correções
  que voltam, desfecho).
- **`distill:corrections`**: correção repetida vira regra e um juiz confere se está em alguma
  skill; a que não está vai pro primer. Regra que não sai mais numa rodada vira `stale`.
- **Detector de correção só por marcador no texto.** No gabarito de 60 mensagens a versão com
  sinais estruturais (depois de interromper, de recusa sem motivo ou de erro de tool) acertava
  20% das fortes; esses sinais agora só anotam contexto. `metrics:workflow -- gate` mede o
  detector vigente pelo grafo e `gold --append` gera lote de validação fora da amostra.
- **`metrics:workflow`**: portão de qualidade da captura (medido em 10/11: pareamento por posição
  99,99%, erro pelo texto 98,6% a 100% em exit/tool_error/rejected; hook e interrupted ficaram de
  fora) e série semanal contra um marco zero, no `memory://profile`. `recall_task`,
  `find_decisions`, `find_related_plans`, `list_project_activity` e `my_flow` passam a ir pro
  query-log.
- `skill_doc` fica fora do `search_memory` padrão (só com `scope`).
- **Push só conta o que chegou.** Quando o curl do hook desistia (prazo total no fim) ou o server
  estourava os 850ms, o aviso era descartado mas a sessão já ficava marcada como citada, o teto
  andava e o query-log gravava hit. Agora estado e hit só valem depois de a resposta sair inteira
  pro socket com o cliente ainda conectado; o resto vai pro log como `delivered: false`, sem hit,
  e aparece no `memory://profile` ("passaram no gate e não chegaram"). O hook manda o `--max-time`
  da tentativa em `x-deadline-ms` e o server encurta o prazo pra responder antes do curl desistir.
  Vale pro push de prompt e de arquivo.
- **Push não roda em turno que não é da pessoa**: retorno de subagente, `<task-notification>`,
  `<system-reminder>`, mensagem de outra sessão, resumo de contexto e texto de skill são pulados
  antes da busca. Prompt que abre com tag (`<Button>`, XML colado) continua indo pra busca. A regra
  (`isHarnessTurn`) mora no `quality.ts` e o detector de correção usa a mesma.

- **Pasta de task fora do repo** (`$TASKS_HOME/<id>/`, default `$CODE_HOME/.claude/tasks`):
  contexto, cenários e plano da task num lugar só, lido por todos os repos da task. Id
  provisório (nome do worktree) até a task existir; `scripts/task-folder.sh link KEY` renomeia
  e o grafo funde as conversas de antes na task. `tasks:gc` apaga a pasta depois de ingerida,
  quando todos os PRs estão mergeados ou depois de 30 dias parada sem PR aberto. Só o markdown
  é ingerido: outros arquivos da pasta (prints, json) saem junto.
- **PRs no grafo** (`sync:prs`, precisa `GH_PR_OWNER` e `gh`): estado, branch, descrição como
  chunk, `REPLACES` entre PR fechado e o seguinte, sessão ligada pela branch. `recall_task`
  mostra os PRs e a pasta.
- **Docs do repo** (`--source=repo-docs`): markdown commitado na branch padrão de cada repo,
  com último autor e data. `REPO_DOCS=0` desliga.
- **Pesquisa**: notas em `$RESEARCH_HOME` (source `research`, nunca apagadas), tipo `finding`
  na distilação e `Session.kind = 'research'` pra sessão sem escrita nem PR.
- **Correção de metadados de sessão**: arquivo de subagente (mesmo sessionId) sobrescrevia
  início, fim, contagem e branch da sessão pai. Agora completa em vez de sobrescrever, e a
  contagem sai das mensagens no grafo. Worktree (Orca, `.claude/worktrees`) passa a contar
  como o repo de origem, com `Session.worktree`/`worktreeName`. Migração única:
  `npm run fix:sessions -- --apply` (grava snapshot antes) e `npm run db:init`.

## 0.4.4 (2026-10-30)

- **Hook de push não estoura mais o timeout de 3s** (`UserPromptSubmit hook ... timed out`).
  Antes ele tentava os sockets em ordem alfabética com 1s cada, e com várias sessões abertas
  e a máquina em swap, 3 servers lentos seguidos já passavam de 3s. Agora tem prazo total de
  1,7s, e começa pelo último server que respondeu (`~/.cache/mcp-talks-cc/sock/last`), que é
  o que já tem o modelo quente.
- MCP server descarrega o bge-m3 após 15 min sem busca nem push (o malloc cai de ~1,5GB pra
  ~23MB); o próximo uso recarrega em ~1s. `MCP_TALKS_EMBED_IDLE_MIN=N` ajusta, `0` desliga.
  Com `MCP_TALKS_PRELOAD=1` o padrão é não descarregar.
- Recomendado: subir o `timeout` dos hooks `push-recall.sh` no `~/.claude/settings.json` de 3
  pra 5 (folga, o script já sai antes de 3s).

## 0.4.3 (2026-10-22)

- MCP server não pré-carrega mais o bge-m3 ao subir: carrega na 1ª busca ou no 1º push. Só o
  server que atende os hooks (1º socket vivo) fica com o modelo na RAM; sessões ociosas ficam
  leves. A 1ª busca de uma sessão fria leva alguns segundos. `MCP_TALKS_PRELOAD=1` restaura o
  preload.
- Hook de ingest roda com prioridade baixa de CPU e disco (`nice -n 19` + `ionice -c3` no
  Linux, `taskpolicy -b` no macOS; sem elas, roda normal). `MCP_TALKS_LOWPRI=0` desliga.

## 0.4.2 (2026-10-20)

- **Hook sobe o runtime do Docker** quando o daemon não responde (sessão aberta logo depois do
  boot, antes do Docker iniciar). Antes ele só tentava o `compose up`, falhava e o primer
  alertava `neo4j-down` até a próxima sessão. Só mexe onde o Neo4j mora: com o banco de pé o
  hook anota em qual `docker context` está o container (só `docker ps` em daemon que já
  responde) e, quando cai, sobe aquele runtime e roda o compose naquele context. Neo4j nativo
  ou remoto não liga daemon nenhum. O comando de start sai do socket do context (OrbStack,
  Colima, Rancher Desktop, Podman machine, Docker Desktop no macOS, dockerd rootless); outro
  runtime vai por `MCP_TALKS_DOCKER_START` no `.env`. Daemon que não sobe vira status
  `docker-down`, separado de `neo4j-down`.
- Hooks checam host e porta do `NEO4J_URI` em vez de `localhost:7687` fixo.
- **Primer sem alerta falso**: o health é do run anterior, então com a porta Bolt aberta ou
  ingest rodando ele não alerta (só um aviso leve se o último run tinha caído).
- **Alerta não vira tarefa do user**: o Claude confere o `health.json` e, se precisar, roda o
  próprio `session-ingest.sh` em background. Bloco do CLAUDE.md vai pra v5 (o primer pergunta
  se aplica).

## 0.4.1 (2026-10-15)

- Vínculo task -> epic com Haiku vira **opt-in próprio** (`MCP_TALKS_EPIC_LLM`), separado da
  distilação. Custa bem menos (~2k tokens e só em sessão que cita epic) e é o que dá a cobertura
  (sem ele só entra o caso literal, ~1/3 dos pais). O primer pergunta ("Ligar - maior precisão" /
  "Só regex") pra quem está com a distilação desligada, ou logo depois de um "não" pra ela.
  Sem a linha no `.env` o comportamento segue a distilação, então quem já tinha ligado não muda.
  Resposta: `npm run upgrade -- --epic-llm=on|off`.

## 0.4.0 (2026-10-15)

Epic como ponte entre repos: regra escrita no back passa a aparecer no front (e vice-versa)
quando as duas tasks são filhas do mesmo epic. Nada acessa o Jira: a hierarquia vem do que já
está na memória.

- **Vínculo task -> epic** (`npm run link:epics`, `src/epics/link.ts`): `(Task)-[:PART_OF]->(Task:Epic)`
  e `(Epic)-[:RELATES]->(Epic)`, de três fontes, em ordem de confiança:
  - linha fixa `[task] KEY-1 pai=KEY-2 (Epic: título)` que o fluxo "analise KEY" passa a emitir
    (bloco do CLAUDE.md v4);
  - Haiku lendo só os trechos em volta de "épico/parent/pai" (~2k tokens por sessão, opt-in junto
    com a distilação, 5 sessões por SessionStart);
  - regex no caso inequívoco ("Épico EDC-1001" com 1 task na sessão), sem custo.
  Medido contra o Jira: 20/20 vínculos certos. O Haiku só troca o pai dado por outra fonte com
  confiança high (em medium ele confundiu PRD com epic). Projeto meta (o próprio mcp-talks-cc)
  não é fonte: tem keys de exemplo. Epic balde (Bugs, Débitos técnicos) não forma família;
  override com `MCP_TALKS_EPIC_BUCKETS` / `MCP_TALKS_EPIC_NOT_BUCKETS`.
- **Consumo**:
  - `find_decisions({ taskId })` traz também as decisões das tasks irmãs e do epic (metade das
    vagas, outro repo primeiro), marcadas `via irmã EDC-X`.
  - Tool nova `recall_task({ taskKey })`: índice da task em ~300 tokens (repos, epic, irmãs,
    contagem de decisões, planos, arquivos).
  - Push por arquivo anexa 1 regra de outro repo do mesmo epic que cite o assunto do arquivo.
  - Primer: sessão aberta numa branch de task ganha as regras das irmãs
    (`~/.cache/mcp-talks-cc/epic-primer/<KEY>.txt`, gerado pelo link:epics).
  - `search_memory`: sessões de irmãs ganham boost 1.2 no MMR (`bench:epic-cross`: MRR do 1º hit
    de outro repo 0.147 -> 0.200; `bench:task-recall` inalterado, 100% / 0.990).
- **Base**: `taskKeyFromSlug` centraliza o regex de slug; TaskMemoryDoc ganha `ABOUT_TASK`; stats
  contam todo label; `memory://schema` documenta Decision, Epic, PART_OF e RELATES; chamada
  `claude -p` do distill extraída pra `src/distill/headless.ts`.
- **Kin ligado** (`entityBoost` 1 -> 1.35): boost das sessões irmãs (mesma task ou arquivo escrito
  em comum) estava morto desde que entrou. Medido no `bench:recall` (39 casos, contra a main):
  r@3 73.0% -> 75.7%, MRR 0.675 -> 0.684, ruído igual (10.9%). Boost por epic sozinho empata com
  a main no mesmo bench (não piora a busca geral).
- **Bench novo** `npm run bench:epic-cross`. `bench:recall` passa o caller do caso, então o kin e o
  boost por epic passam a ser medidos no A/B.

Minor: o primer pergunta "atualizar agora". O `npm run upgrade` ganha o passo 6/7, que roda
`build:entities` e `link:epics --no-llm` na hora (sem esperar chunk novo), e em seguida o Claude
mostra o diff do bloco v4 do CLAUDE.md (linha `[task]` e `recall_task` no fluxo de análise). A parte
do vínculo com Haiku segue o opt-in da distilação.

## 0.3.4 (2026-10-07)

- Hook recria o `value-model.json` quando ele não existe. O modelo mora em `~/.cache`, então
  máquina nova ou cache limpo ficava sem ele, e o hook só logava "pulado": chunk novo entrava
  sem `valueScore` (busca recente sem rebaixar narração) e o distill nunca achava sessão
  elegível ("0 sessões" a cada run). Agora o hook treina (~20s, em background) e reclassifica
  o acervo. `train:value --strict` não grava modelo que não separa (grafo pequeno): o hook
  tenta de novo na próxima sessão.

## 0.3.3 (2026-10-06)

- Primer para de dar `[ALERTA]` falso no primeiro SessionStart depois da instalação. O ingest
  async começa junto com o primer e só grava o `health.json` ao terminar, então "sem health"
  ali é corrida, não falha. Com lock de ingest ativo ou log sem nenhum start, o primer agora
  solta só um aviso de "primeiro ingest em andamento", sem mandar rodar ingest manual.

## 0.3.2 (2026-10-02)

- Fim do pico de CPU ao abrir sessão. Arquivo que mudou (sessão que cresceu) era re-embedado
  inteiro a cada SessionStart: ~300 chunks e ~75s com todos os cores cravados por sessão longa.
  Agora só passa pelo modelo o chunk novo ou com texto diferente; o resto reaproveita o vetor
  gravado. Medido: sessão de 295 chunks foi de ~73s pra 320ms, ingest do hook ~2s.
- Ingest do hook limita o onnx a metade dos cores (`MCP_TALKS_BG=1`). O bge-m3 escala mal
  depois de ~4 threads, então não fica mais lento. `EMBED_THREADS=N` no `.env` fixa o número.
  MCP server e `npm run` manual seguem sem limite.

Nada a fazer: `git pull` basta. A primeira sessão depois do pull ainda embeda o que estiver
pendente; dali em diante cai pra segundos.

## 0.3.1 (2026-10-01)

- Fim do `[ALERTA mcp-talks-cc] ... lock-held` falso. Abrir uma sessão (ou `/clear`) enquanto
  outro ingest rodava gravava `lock-held` no health, e o primer seguinte tratava como falha.
  Quem pula por lock ativo agora só loga; o dono do lock grava o status final.
- Primer compara só `major.minor` da versão: patch não pergunta "atualizar agora".

Nada a fazer: `git pull` basta.

## 0.3.0 (2026-09-29)

### O que fazer ao atualizar

1. Aceitar a pergunta de atualização (ou `npm run upgrade`). Aplica a constraint nova (`Decision.id`), instala os 2 hooks de push
   (`UserPromptSubmit` e `PostToolUse`), calibra a `confidence` por replay se ela ainda não
   estiver pronta e grava a versão instalada.
2. Aceitar a atualização do bloco de memória do `~/.claude/CLAUDE.md` (ou
   `npm run upgrade:claude-md -- --apply`). Sem isso o Claude continua buscando só no começo da
   conversa e não sabe o que fazer com os ponteiros de memória. Se vc customizou essa seção,
   confira o diff: ela é substituída inteira (o resto do arquivo não é tocado).
3. Abra uma sessão nova.

### Opcional

- **Distilação automática**: o Claude pergunta no fluxo de atualização. Desligada até vc
  responder que sim (gasta tokens de Haiku da sua conta, ~10k por sessão destilada). Sem ligar,
  dá pra rodar à mão: `npm run distill -- --limit=10`.
- **Gabarito de recall**: sem ele o gate de citação é percentil em vez de precisão medida, e
  o self-tune não valida proposta de tuning. Ver README, seção Medição.

### O que muda sem você fazer nada

- `search_memory` devolve 1 linha por hit (~450 tokens por busca em vez de ~3.5k) e a tool
  nova `expand_hits` traz o texto completo dos hits escolhidos.
- Ranking: relevância normalizada também no modo vetorial e no máximo 1 hit por sessão (fora
  as sessões da task citada na query). No bench de referência: recall@8 73% -> 89%.
- `confidence` não depende mais de tráfego recente (antes voltava a `null` quando o uso caía).
- `find_decisions` lê as decisões destiladas.

### Compatibilidade

- `structuredContent` só sai com `MCP_TALKS_STRUCTURED=1`. Quem consumia o JSON das tools
  por fora do Claude Code precisa ligar isso.
- `scope` não aceita mais `tool_output` nem `todo` (nunca tiveram chunk). Aceita `decision`.
