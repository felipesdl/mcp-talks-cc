// Loop de auto-avaliação: grada queries do query-log (echo/reformulação/drill-in),
// recomputa profile + primer e PROPÕE tuning.candidate.json (nunca aplica —
// promoção é manual via `npm run self-tune:accept`).
// Disparado pelo session-ingest.sh depois do ingest; idempotente e com lock.
import { appendFile, open, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { withSession, closeDriver } from '../neo4j/driver.ts';
import { learningPaths } from '../learning/paths.ts';
import { readQueryLog } from '../learning/queryLog.ts';
import { readJson, readJsonl, writeAtomic } from '../learning/fsUtil.ts';
import { gradeEntry } from '../learning/grading/grade.ts';
import { calibrateEcho } from '../learning/grading/echo.ts';
import { buildProfile } from '../learning/profile.ts';
import { buildPrimer, type PendingCandidateInfo } from '../learning/primer.ts';
import { buildTuningProposal } from '../learning/tuner.ts';
import { getTuning, sanitizeTuning, tuningEquals } from '../mcp/tuning.ts';
import { buildScoreCalibration } from '../mcp/scoreCalibration.ts';
import { gradeSchema, MIN_ECHO_SAMPLES, MIN_SCORE_SAMPLES, type EchoCalibration, type Grade, type QueryLogEntry, type Tuning } from '../learning/types.ts';

const SETTLE_MS = 45 * 60 * 1000; // espera sinais de follow-up + ingest do transcript
const LOCK_STALE_MS = 30 * 60 * 1000;
const WINDOW_DAYS = 30;
const MAX_GRADES_PER_RUN = 200; // cap de CPU por sessão (embedding local)

async function acquireLock(): Promise<boolean> {
  try {
    const fh = await open(learningPaths.selfTuneLock, 'wx');
    await fh.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
    await fh.close();
    return true;
  } catch {
    const st = await stat(learningPaths.selfTuneLock).catch(() => null);
    if (st && Date.now() - st.mtimeMs > LOCK_STALE_MS) {
      // lock velho de processo morto — assume
      await rm(learningPaths.selfTuneLock, { force: true });
      return acquireLock();
    }
    return false;
  }
}

interface GradeCheckpoint {
  lastGradedTs: string;
}

// `--regrade-from=all` (ou um ISO) re-grada queries já gradadas. Serve pra
// quando o grader em si muda ou estava quebrado: grade antiga com sinal nulo
// não se conserta sozinha, o checkpoint já passou por ela.
const { values: cliArgs } = parseArgs({
  options: { 'regrade-from': { type: 'string' } },
  allowPositionals: true,
});
const regradeFrom =
  cliArgs['regrade-from'] === 'all' ? '' : (cliArgs['regrade-from'] ?? null);

/** Mantém 1 grade por queryTs (a mais recente), senão regrade duplica amostra. */
function dedupeGrades(grades: Grade[]): Grade[] {
  const byTs = new Map<string, Grade>();
  for (const g of grades) {
    const prev = byTs.get(g.queryTs);
    if (!prev || g.ts >= prev.ts) byTs.set(g.queryTs, g);
  }
  return [...byTs.values()];
}

async function main(): Promise<void> {
  if (!(await acquireLock())) {
    console.log('[self-tune] outra instância rodando, saindo.');
    return;
  }
  try {
    const stored =
      (await readJson<GradeCheckpoint>(learningPaths.gradeCheckpoint)) ?? { lastGradedTs: '' };
    const checkpoint: GradeCheckpoint =
      regradeFrom !== null ? { lastGradedTs: regradeFrom } : stored;
    if (regradeFrom !== null) {
      console.log(`[self-tune] regrade a partir de "${regradeFrom || 'início'}"`);
    }
    const { entries } = await readQueryLog(0);
    const priorGrades = dedupeGrades(
      (await readJsonl<Grade>(learningPaths.grades)).filter(
        (g) => gradeSchema.safeParse(g).success,
      ),
    );
    const calibration = await readJson<EchoCalibration>(learningPaths.echoCalibration);

    // gradáveis: search_memory, fora da janela de settling, depois do checkpoint
    const settled = new Date(Date.now() - SETTLE_MS).toISOString();
    const gradable = entries
      .filter(
        (e) =>
          e.tool === 'search_memory' && e.ts > checkpoint.lastGradedTs && e.ts <= settled,
      )
      .sort((a, b) => a.ts.localeCompare(b.ts))
      .slice(0, MAX_GRADES_PER_RUN);

    const newGrades: Grade[] = [];
    if (gradable.length > 0) {
      console.log(`[self-tune] gradando ${gradable.length} queries...`);
      await withSession(async (s) => {
        for (const entry of gradable) {
          const later = entries.filter((e) => e.ts > entry.ts);
          try {
            const grade = await gradeEntry(s, entry, later, calibration);
            newGrades.push(grade);
            await appendFile(learningPaths.grades, JSON.stringify(grade) + '\n');
            // checkpoint avança por entrada graded (crash-safe)
            await writeAtomic(
              learningPaths.gradeCheckpoint,
              JSON.stringify({ lastGradedTs: entry.ts }, null, 2),
            );
          } catch (e) {
            console.error(`[self-tune] grade falhou em ${entry.ts}:`, e instanceof Error ? e.message : e);
          }
        }
      });
    } else {
      console.log('[self-tune] nada novo pra gradar.');
    }

    // newGrades vence prior no mesmo queryTs (regrade sobrescreve)
    const allGrades = dedupeGrades([...priorGrades, ...newGrades]).sort((a, b) =>
      a.queryTs.localeCompare(b.queryTs),
    );

    // regrade deixa linhas velhas no jsonl; reescreve o arquivo já deduplicado
    if (regradeFrom !== null && newGrades.length > 0) {
      await writeFile(
        learningPaths.grades,
        allGrades.map((g) => JSON.stringify(g)).join('\n') + '\n',
      );
    }

    // recalibra echo com TODAS as observações (iterativo: grades novas usaram a calibração antiga)
    const echoRaws = allGrades
      .map((g) => g.signals.echoRaw)
      .filter((v): v is number => v !== null);
    const newCalibration = calibrateEcho(echoRaws, MIN_ECHO_SAMPLES);
    await writeAtomic(learningPaths.echoCalibration, JSON.stringify(newCalibration, null, 2));

    // calibração de score: CDF empírica de vec_score de TODOS os hits já
    // retornados na janela. É o que dá sentido ao `confidence` do search_memory
    // (score cru não é comparável entre queries).
    const windowStartForScores = new Date(
      Date.now() - WINDOW_DAYS * 24 * 3600 * 1000,
    ).toISOString();
    const vecScores = entries
      .filter((e) => e.tool === 'search_memory' && e.ts >= windowStartForScores)
      .flatMap((e) => e.hits.map((h) => h.vecScore));
    const scoreCalibration = buildScoreCalibration(vecScores, MIN_SCORE_SAMPLES);
    await writeAtomic(
      learningPaths.scoreCalibration,
      JSON.stringify(scoreCalibration, null, 2),
    );

    // janela trailing p/ profile/tuner
    const windowStart = new Date(Date.now() - WINDOW_DAYS * 24 * 3600 * 1000).toISOString();
    const entryByTs = new Map<string, QueryLogEntry>(entries.map((e) => [e.ts, e]));
    const graded = allGrades
      .filter((g) => g.queryTs >= windowStart)
      .map((g) => ({ grade: g, entry: entryByTs.get(g.queryTs) }))
      .filter((x): x is { grade: Grade; entry: QueryLogEntry } => x.entry !== undefined);

    const profile = buildProfile(graded, WINDOW_DAYS);
    await writeAtomic(learningPaths.profile, JSON.stringify(profile, null, 2));

    // candidate antes do primer: o primer avisa sobre pendência de tuning
    const { candidate, rationale } = buildTuningProposal(
      graded,
      profile,
      getTuning(),
      newCalibration,
      scoreCalibration,
    );
    await writeAtomic(learningPaths.tuningRationale, rationale);
    let pendingCandidate: PendingCandidateInfo | null = null;
    if (candidate && tuningEquals(sanitizeTuning(candidate), getTuning())) {
      // Proposta idêntica ao tuning já aplicado não é pendência. Sem esse ramo,
      // todo run pós-accept regenera o mesmo candidate e o primer cobra um
      // accept que já aconteceu.
      await rm(learningPaths.tuningCandidate, { force: true });
      console.log(
        `[self-tune] candidate == tuning aplicado (${graded.length} grades), nada a promover. Detalhe: ${learningPaths.tuningRationale}`,
      );
    } else if (candidate) {
      // mesmo conteúdo do run anterior -> preserva updatedAt p/ o primer mostrar a idade real da pendência
      const prev = await readJson<Tuning>(learningPaths.tuningCandidate);
      const sameContent =
        prev &&
        JSON.stringify({ ...prev, updatedAt: '' }) === JSON.stringify({ ...candidate, updatedAt: '' });
      if (sameContent && prev) candidate.updatedAt = prev.updatedAt;
      await writeAtomic(learningPaths.tuningCandidate, JSON.stringify(candidate, null, 2));
      pendingCandidate = { proposedAt: candidate.updatedAt, nGrades: graded.length };
      console.log(
        `[self-tune] candidate proposto (${graded.length} grades). Revisar: ${learningPaths.tuningRationale} | aplicar: npm run self-tune:accept`,
      );
    } else {
      await rm(learningPaths.tuningCandidate, { force: true });
      console.log(`[self-tune] dados insuficientes p/ candidate (${graded.length} grades). Detalhe: ${learningPaths.tuningRationale}`);
    }

    const primer = buildPrimer(profile, pendingCandidate);
    if (primer) {
      await writeAtomic(learningPaths.primer, primer);
    } else {
      console.log('[self-tune] sem dado aprendido ainda — primer não gerado.');
    }
    console.log(
      `[self-tune] done: +${newGrades.length} grades, mean utility ${profile.lastEval.meanUtility.toFixed(2)}, ` +
        `echo ${newCalibration.ready ? 'calibrado' : `${newCalibration.nSamples}/${MIN_ECHO_SAMPLES}`}, ` +
        `score ${scoreCalibration.ready ? 'calibrado' : `${scoreCalibration.nSamples}/${MIN_SCORE_SAMPLES}`}`,
    );
  } finally {
    await unlink(learningPaths.selfTuneLock).catch(() => {});
    await closeDriver();
  }
}

await main();
