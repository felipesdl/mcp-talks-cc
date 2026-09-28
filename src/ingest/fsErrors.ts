/**
 * Arquivo que sumiu entre a listagem e a leitura. Esperado nos diretórios do
 * Claude Code: o cleanupPeriodDays apaga transcript velho no startup, na mesma
 * hora em que o hook SessionStart dispara o ingest.
 */
export function isVanished(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | null)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

/**
 * Contabiliza erro de leitura de UM arquivo sem derrubar o run. Só pode envolver
 * I/O de arquivo: erro de Neo4j ou de embedding tem que continuar abortando,
 * senão banco fora vira "N arquivos falharam" com exit 0 e health ok.
 */
export function countReadError(
  tag: string,
  path: string,
  err: unknown,
  counters: { vanished: number; failed: number },
): void {
  if (isVanished(err)) {
    counters.vanished++;
    return;
  }
  counters.failed++;
  console.error(`[${tag}] falha lendo ${path}:`, err);
}
