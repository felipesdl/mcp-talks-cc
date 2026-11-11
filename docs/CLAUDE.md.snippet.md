# Snippet pro seu `~/.claude/CLAUDE.md`

Cole o bloco abaixo no seu `~/.claude/CLAUDE.md` (escopo de usuário, vale em todos os
projetos). **Sem ele o MCP conecta mas não é usado direito:** o Claude não sabe quando
buscar, e lê `score` em vez de `confidence` — o que aprova qualquer hit, inclusive lixo.

Substitua `KEY` pelo prefixo do seu projeto Jira (`EDC`, `US`, `AQ`, ...) onde fizer
sentido, ou deixe genérico como está — o retrieval já trata `[A-Z]{2,}-\d+` como token
literal, então funciona pra qualquer prefixo.

---

<!-- mcp-talks-cc:snippet v6 (npm run upgrade compara esta versão) -->
## Memória cross-conversa (MCP `mcp-talks-cc`)

MCP local (`mcp__mcp-talks-cc__*`; chame de mcp-talks-cc, nunca "memory") que indexa conversas passadas, plans, pastas de task, PRs, docs dos repos, pesquisas e decisões destiladas. Como ler os números, parâmetros e dicas de query: descrição das tools e `memory://schema`. `memory://profile` responde "oq vc aprendeu de mim".

**Quando buscar (regra firme).** Antes de responder sobre decisão passada, abordagem já discutida ou contexto de task/projeto: `search_memory` primeiro. Busque de novo quando o assunto mudar, antes de decisão de design, diante de erro que parece já visto, ao abrir módulo novo na conversa ou quando o user citar o passado ("como fizemos"). 2-3 buscas por conversa é normal; a saída é 1 linha por hit, leia só o que for usar com `expand_hits`. Não buscar: pergunta trivial, sintaxe genérica, assunto claramente novo.

**Citar.** Decide pela `confidence` (`conf=`), nunca pelo `score`. Cortes vigentes: linha `gate de citação` do primer (sem ela: forte >= 0.90, ignorar < 0.59; com `conf n/a`, nada é forte). Forte: 1 frase "Já discutimos X em <plan/session/task>: <gist>". Meio: só se for útil, como "possivelmente relacionado". Máx 3 referências por resposta, resumidas, sem colar snippet.

**Primer e ponteiros.** O primer `[memória mcp-talks-cc ...]` do início é índice (temas, gate); detalhe sempre via busca. Ponteiro `[memória mcp-talks-cc] talvez relevante: id=...` é sinal, não resposta: se servir, `expand_hits` antes de usar; se não, ignore em silêncio, sem comentar com o user. Ponteiro de arquivo ("já foi alterado em: <tasks>"): se a task tem a ver, `search_memory` com o arquivo ou a task.

**Task do Jira** ("analise KEY-1234"). Depois de buscar no Jira, escreva a linha exata `[task] KEY-1234 pai=KEY-1200 (Epic: <título>)` (`História:` se o pai é story, `pai=-` sem pai): é ela que liga a task ao epic entre repos. Depois `recall_task({ taskKey })` (PRs, pasta, irmãs em outros repos) e, se tiver irmã, `find_decisions({ taskId })`. Pra 2-3 tópicos técnicos da task (abstratos, com domínio): `search_memory({ query, k: 4, project })` e a regra de citação acima.

**Ingest.** Automático no SessionStart; nunca peça pro user rodar. Com `[ALERTA mcp-talks-cc]` no primer, confira `~/.cache/mcp-talks-cc/health.json`; se não estiver `ok`, rode em background `bash /ABSOLUTE/PATH/TO/mcp-talks-cc/scripts/session-ingest.sh` e só avise se falhar de novo (última linha do `ingest.log`). `memory://stats` com Chunk < 100 = MCP vazio: avise e pule a busca.
