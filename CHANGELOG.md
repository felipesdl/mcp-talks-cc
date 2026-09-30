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
