import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { mutateJsonState } from './state-mutex.ts';
import { resolveEvalsDir } from './evals-paths.ts';

/**
 * Self-healing repair for drifted challenge pairing metadata.
 *
 * Background: a challenge pair is keyed by the primary's issue id (the
 * `pairId`). The primary task is stored under `<pairId>` with
 * `challengePairId=<pairId>` / `challengeRole=primary`; the challenger is
 * stored under `<pairId>_c` with `challengePairId=<pairId>` /
 * `challengeRole=challenger`. `compare-prs` finds both eval records by
 * `challengePairId === pairId`, so if the challenger ever drifts to
 * `challengePairId=<pairId>_c` (e.g. it re-derived its own routing as if it
 * were a primary), the comparison fails with "Missing eval records" and the
 * challenge stalls before evaluation.
 *
 * This repair re-anchors the challenger task to `<pairId>` and relabels any
 * mis-filed challenger eval record from `<pairId>_c` back to `<pairId>` so the
 * comparison can pair both sides. It is idempotent: running it on an
 * already-consistent pair makes no changes.
 */
export interface RepairChallengePairingOptions {
  pairId: string;
  repoDir: string;
  /** Override the workflow-state.json path (defaults to <repoDir>/.wavemill/workflow-state.json). */
  statePath?: string;
  /** Override the evals directory (defaults to the repo's resolved evals dir). */
  evalsDir?: string;
}

export interface RepairChallengePairingResult {
  pairId: string;
  challengerKey: string;
  /** True if the challenger task's challengePairId/challengeRole were corrected. */
  taskRepaired: boolean;
  /** Number of eval records relabeled from `<pairId>_c` to `<pairId>`. */
  recordsRelabeled: number;
}

function resolveStatePath(opts: RepairChallengePairingOptions): string {
  return opts.statePath ?? join(opts.repoDir, '.wavemill', 'workflow-state.json');
}

function resolveEvalsFilePath(opts: RepairChallengePairingOptions): string {
  const dir = opts.evalsDir ?? resolveEvalsDir(undefined, opts.repoDir).dir;
  return join(dir, 'evals.jsonl');
}

/**
 * Re-anchor a drifted challenger task entry to its canonical pair id/role.
 * Returns whether any field was changed.
 */
async function repairChallengerTask(
  statePath: string,
  pairId: string,
  challengerKey: string,
): Promise<boolean> {
  if (!existsSync(statePath)) return false;
  let changed = false;
  await mutateJsonState<any>(statePath, (state) => {
    const task = state?.tasks?.[challengerKey];
    if (!task) return state;
    if (task.challengePairId !== pairId) {
      task.challengePairId = pairId;
      changed = true;
    }
    if (task.challengeRole !== 'challenger') {
      task.challengeRole = 'challenger';
      changed = true;
    }
    return state;
  });
  return changed;
}

/**
 * Relabel mis-filed challenger eval records. Processes the JSONL line-by-line
 * so unparseable lines are preserved verbatim rather than dropped.
 */
function relabelEvalRecords(evalsFile: string, pairId: string): number {
  if (!existsSync(evalsFile)) return 0;
  const drifted = `${pairId}_c`;
  const lines = readFileSync(evalsFile, 'utf-8').split('\n');
  let relabeled = 0;
  const next = lines.map((line) => {
    if (!line.trim()) return line;
    let record: any;
    try {
      record = JSON.parse(line);
    } catch {
      return line; // preserve malformed lines untouched
    }
    if (record.challengePairId === drifted) {
      record.challengePairId = pairId;
      relabeled += 1;
      return JSON.stringify(record);
    }
    return line;
  });
  if (relabeled > 0) {
    writeFileSync(evalsFile, next.join('\n'), 'utf-8');
  }
  return relabeled;
}

export async function repairChallengePairing(
  opts: RepairChallengePairingOptions,
): Promise<RepairChallengePairingResult> {
  const { pairId } = opts;
  const challengerKey = `${pairId}_c`;
  const taskRepaired = await repairChallengerTask(
    resolveStatePath(opts),
    pairId,
    challengerKey,
  );
  const recordsRelabeled = relabelEvalRecords(resolveEvalsFilePath(opts), pairId);
  return { pairId, challengerKey, taskRepaired, recordsRelabeled };
}
