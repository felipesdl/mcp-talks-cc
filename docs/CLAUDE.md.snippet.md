# Snippet pro seu `~/.claude/CLAUDE.md`

Cole o bloco abaixo no seu `~/.claude/CLAUDE.md` (escopo de usuário, vale em todos os
projetos). **Sem ele o MCP conecta mas não é usado direito:** o Claude não sabe quando
buscar, e lê `score` em vez de `confidence` — o que aprova qualquer hit, inclusive lixo.

Substitua `KEY` pelo prefixo do seu projeto Jira (`EDC`, `US`, `AQ`, ...) onde fizer
sentido, ou deixe genérico como está — o retrieval já trata `[A-Z]{2,}-\d+` como token
literal, então funciona pra qualquer prefixo.

---

## Memória cross-conversa (MCP `mcp-talks-cc`)

O server MCP se chama `mcp-talks-cc` (tools no formato `mcp__mcp-talks-cc__*`). Sempre referir a ele por esse nome, nunca "memory". MCP local indexa conversas Claude Code passadas, plans, todos e task memory em Neo4j com busca vetorial. Tools: `search_memory`, `get_session_transcript`, `find_related_plans`, `find_decisions`, `list_project_activity`. Resources: `memory://stats`, `memory://schema`, `memory://profile` (perfil aprendido pelo self-tune; use pra responder "oq vc aprendeu de mim").

### Quando consultar (regra firme)

Antes de responder sobre decisão passada, abordagem já discutida, ou contexto de task/projeto: **busca primeiro com `search_memory`, só então responde**. Não é opcional nesses casos.

Exceções (não buscar): pergunta trivial/casual, sintaxe genérica de linguagem/framework, assunto claramente novo que nunca passou pelos projetos.

No início de cada sessão pode vir um primer `[memória mcp-talks-cc ...]` com projetos quentes, temas e buscas de alto valor. Se a pergunta bate com tema do primer, é sinal forte de buscar. O primer é só índice: pra detalhe, sempre `search_memory`.

### Fluxo de análise de task do Jira

Quando o user pedir "analise KEY-1234" (ou variações tipo "vamos mexer na KEY-1234"), onde `KEY` é qualquer prefixo de projeto Jira:

1. **Busca a task no Jira** normalmente (skill de análise de issue ou MCP atlassian)
2. Da description + comentários da task, **identifique 2-3 tópicos técnicos centrais** (ex: "feature flag", "react query cache", "validação form com react-hook-form", "migration Laravel"). Você decide o que é relevante — não copie literalmente, abstraia.
3. Para cada tópico, chame `search_memory({ query: <tópico>, k: 4 })`. Se a task menciona repo específico, passe `project`: é soft boost (prioriza o repo sem esconder os outros, regras cruzam repos). Só use `projectStrict: true` quando quiser literalmente 1 repo.
4. **Avalie `confidence`, nunca `score`** (ver "Como ler os números" abaixo). Os cortes `FORTE` e `PISO` não são constantes: leia os valores vigentes antes de decidir (ver abaixo de onde).
   - confidence >= `FORTE`: hit forte. Integre 1 frase no início da análise no formato: `"Já discutimos <tópico> em <plan: slug> / <session: <sessionId> / <task: KEY-5678>>: <gist 1 linha>"`
   - confidence entre `PISO` e `FORTE`: hit fraco. Mencione apenas se for diretamente útil. Cite com cautela ("possivelmente relacionado:...")
   - todos < `PISO`: não mencione memória. Apenas prossiga com análise da task.
   - `confidence: null` (calibração ainda coletando amostras): trate como hit fraco, nunca como forte.
5. **Limite máximo: 3 referências de memória no output total**, mesmo que vários tópicos tenham hits fortes. Resuma. Não cole snippets longos.
6. Output final: análise da task Jira + (no máx) 3 linhas de "memória relevante" + plano de execução normal.

### Como ler os números do `search_memory`

Cada hit vem com `conf=` e `score=`. **São coisas diferentes:**

- `confidence` (0..1): percentil do hit contra a distribuição histórica de similaridade. `conf=0.90` significa "melhor que 90% dos hits que essa busca normalmente devolve". É comparável entre queries, então **é o único número que decide se cita**. `null` = calibração local ainda sem amostra suficiente.
- `score`: fusão vetor + BM25, serve só pra ordenar dentro da MESMA query. Não é comparável entre queries e não tem corte absoluto útil: o embedder (bge-m3) devolve cosseno entre 0.86 e 0.91 pra praticamente qualquer coisa. Cortar score em 0.70 aprova 100% dos hits, inclusive lixo.
- O cabeçalho traz `pool: N candidatos, vec mediano=X`: é o piso de similaridade daquela busca. Hit perto da mediana do pool é ruído.
- **`FORTE` e `PISO` não são constantes, são percentis, e se movem.** São o p75 e o p25 da confidence do MELHOR hit por query, sobre uma amostra de 1 ponto por query gradada. Amostra pequena significa deriva real: número cravado no CLAUDE.md envelhece em dias.
- **Fonte dos valores vigentes:** a linha `sugestão de gate pro CLAUDE.md` em `~/.cache/mcp-talks-cc/tuning-rationale.md`, seção "score / confidence". Ela é regerada a cada sessão pelo self-tune. Leia ela antes de citar memória (1 leitura por sessão basta, o valor serve pra todas as buscas daquela sessão).
- **Fallback**, quando o arquivo não existe, a seção não está lá, ou a busca devolve `confidence: null` (`calibrated: false`): `FORTE = 0.90`, `PISO = 0.59`, e todo o meio é fraco. Com `confidence: null` nenhum hit pode ser tratado como forte, independente do score.

### Anti-padrões

- Não chame `search_memory` para cada palavra. Tópicos abstratos (`"feature flag pattern"`) recupera melhor que palavras isoladas (`"flag"`).
- Não cole snippets crus da memória na resposta. Resuma em 1 frase.
- Se `memory://stats` mostrar Chunk < 100, o MCP está vazio/quebrado — avise o user e pule busca de memória.
- Tópicos genéricos ("typescript", "react") trazem ruído. Prefira combinar com domínio: "typescript zod validation form".

### Hybrid retrieval & diversidade

- `search_memory` é hybrid (vector + BM25 fulltext), mas o BM25 **só liga com token literal de verdade**: `KEY-1234`, path com extensão, camelCase (`useEffect`), snake_case, CONST_CASE, sigla (`MCP`) ou versão (`5.26`). Pergunta em prosa roda vetor puro, e isso é o certo. Passe a query natural, não tente truncar.
- Parâmetro `diversity` (0..1, default 0.7) controla MMR. Use `0.3` quando quiser variedade ("panorama do tema X em todas conversas"), `0.9` quando quiser foco em 1 tópico ("aprofunde decisão Y").
- Pra "mostre outras conversas parecidas a esta", use `find_similar_chunks({ chunkId, k: 5 })` em vez de nova `search_memory`. Não re-embeda — usa edges SIMILAR_TO precomputadas (~10ms).

### Ingest: automático, com alarme

O hook SessionStart ingere sozinho (incremental, sobe o Neo4j se estiver parado, lock por pid). **Não existe re-ingest manual de rotina.**

Se o primer trouxer uma linha `[ALERTA mcp-talks-cc]`, a memória está desatualizada ou o ingest falhou: avise na primeira resposta e rode

```bash
cd /ABSOLUTE/PATH/TO/mcp-talks-cc && npm run ingest -- --source=all
```

Diagnóstico: `~/.cache/mcp-talks-cc/health.json` (status + último ok) e `ingest.log`.

Limite conhecido: o Claude Code poda transcript com 90 dias (`cleanupPeriodDays`). O grafo é o único registro do que já foi podado, então gap de ingest maior que isso é perda definitiva.
