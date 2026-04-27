import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

export interface BackfillResult {
  scanned: number;
  marked: number;
  alreadyMarked: number;
}

interface EvalLikeRecord {
  rubric_provenance?: string;
  [key: string]: unknown;
}

export async function backfillRubricProvenance(options: {
  repoDir: string;
  dryRun?: boolean;
}): Promise<BackfillResult> {
  const evalsPath = join(options.repoDir, '.wavemill', 'evals', 'evals.jsonl');
  if (!existsSync(evalsPath)) {
    throw new Error(`Eval records file not found: ${evalsPath}`);
  }

  const content = readFileSync(evalsPath, 'utf-8');
  const lines = content.split('\n');
  const outputLines: string[] = [];
  let scanned = 0;
  let marked = 0;
  let alreadyMarked = 0;

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (!line.trim()) {
      continue;
    }

    let record: EvalLikeRecord;
    try {
      record = JSON.parse(line) as EvalLikeRecord;
    } catch (error) {
      throw new Error(
        `Failed to parse ${evalsPath} at line ${index + 1}: ${(error as Error).message}`,
      );
    }

    scanned += 1;

    if (record.rubric_provenance) {
      alreadyMarked += 1;
      outputLines.push(line);
      continue;
    }

    marked += 1;
    outputLines.push(
      JSON.stringify({
        ...record,
        rubric_provenance: 'legacy_absent',
      }),
    );
  }

  if (options.dryRun) {
    return { scanned, marked, alreadyMarked };
  }

  const tmpPath = join(dirname(evalsPath), `.evals-rubric-backfill-${randomUUID()}.tmp`);
  mkdirSync(dirname(evalsPath), { recursive: true });

  try {
    const output = outputLines.length > 0 ? `${outputLines.join('\n')}\n` : '';
    writeFileSync(tmpPath, output, 'utf-8');
    renameSync(tmpPath, evalsPath);
  } catch (error) {
    rmSync(tmpPath, { force: true });
    throw error;
  }

  return { scanned, marked, alreadyMarked };
}
