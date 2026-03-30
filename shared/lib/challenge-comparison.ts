import { mkdirSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

export interface ChallengeRoutingMeta {
  planner: string;
  coder: string;
  reviewer: string;
  planDepth: string;
  codeDepth: string;
  reviewMode: string;
}

export interface ChallengeComparison {
  challengePairId: string;
  primaryModel: string;
  challengerModel: string;
  primaryPrUrl: string;
  challengerPrUrl: string;
  primaryEvalScore: number;
  challengerEvalScore: number;
  winner: 'primary' | 'challenger';
  winnerModel: string;
  rationale: string;
  dimensions: {
    correctness: { primary: number; challenger: number };
    codeQuality: { primary: number; challenger: number };
    completeness: { primary: number; challenger: number };
    scopeDiscipline: { primary: number; challenger: number };
  };
  timestamp: string;
  primaryRouting?: ChallengeRoutingMeta;
  challengerRouting?: ChallengeRoutingMeta;
}

const DEFAULT_EVALS_DIR = '.wavemill/evals';
const CHALLENGE_RECORDS_FILENAME = 'challenge-records.jsonl';

function resolveRecordsFile(dir?: string): string {
  const baseDir = resolve(dir || DEFAULT_EVALS_DIR);
  return join(baseDir, CHALLENGE_RECORDS_FILENAME);
}

export function appendChallengeComparison(record: ChallengeComparison, dir?: string): void {
  const filePath = resolveRecordsFile(dir);
  const outDir = dirname(filePath);
  mkdirSync(outDir, { recursive: true });

  const tmpPath = join(outDir, `.challenge-records-${randomUUID()}.tmp`);
  const existing = existsSync(filePath) ? readFileSync(filePath, 'utf-8') : '';
  writeFileSync(tmpPath, `${existing}${JSON.stringify(record)}\n`, 'utf-8');
  renameSync(tmpPath, filePath);
}

export function readChallengeComparisons(dir?: string): ChallengeComparison[] {
  const filePath = resolveRecordsFile(dir);
  if (!existsSync(filePath)) {
    return [];
  }

  return readFileSync(filePath, 'utf-8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as ChallengeComparison];
      } catch {
        return [];
      }
    });
}
