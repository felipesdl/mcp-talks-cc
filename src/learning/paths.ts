import { join } from 'node:path';
import { config } from '../config.ts';

const dir = config.paths.cacheDir;

export const learningPaths = {
  cacheDir: dir,
  queryLog: join(dir, 'query-log.jsonl'),
  grades: join(dir, 'grades.jsonl'),
  gradeCheckpoint: join(dir, 'grade-checkpoint.json'),
  echoCalibration: join(dir, 'echo-calibration.json'),
  scoreCalibration: join(dir, 'score-calibration.json'),
  probeSamples: join(dir, 'probe-samples.json'),
  benchRecall: join(dir, 'bench-recall.jsonl'),
  benchGate: join(dir, 'bench-gate.json'),
  recallEval: join(dir, 'recall-eval.jsonl'),
  sessionsDir: join(dir, 'sessions'),
  health: join(dir, 'health.json'),
  profile: join(dir, 'profile.json'),
  primer: join(dir, 'primer.json'),
  tuning: join(dir, 'tuning.json'),
  tuningCandidate: join(dir, 'tuning.candidate.json'),
  tuningRejected: join(dir, 'tuning.rejected.json'),
  tuningRationale: join(dir, 'tuning-rationale.md'),
  tuningSnapshot: join(dir, 'tuning.snapshot.json'),
  selfTuneLock: join(dir, 'self-tune.lock'),
} as const;
