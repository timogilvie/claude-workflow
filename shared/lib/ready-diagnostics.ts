import { appendFile, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';

export interface PreflightDiagnostic {
  stage: string;
  tool: string;
  classification: 'preflight-failure' | 'ref-missing' | 'tool-error' | 'config-missing';
  reason: string;
  rawError?: string;
  exitCode?: number;
}

const PRECHECK_FILE = '.ready-preflight.jsonl';

export async function writePreflightDiagnostic(
  stateDir: string,
  diagnostic: PreflightDiagnostic,
): Promise<void> {
  await mkdir(stateDir, { recursive: true });
  const entry = {
    timestamp: new Date().toISOString(),
    ...diagnostic,
  };
  await appendFile(path.join(stateDir, PRECHECK_FILE), `${JSON.stringify(entry)}\n`, 'utf-8');
}

export async function readPreflightDiagnostics(stateDir: string): Promise<PreflightDiagnostic[]> {
  try {
    const raw = await readFile(path.join(stateDir, PRECHECK_FILE), 'utf-8');
    return raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line) as PreflightDiagnostic);
  } catch {
    return [];
  }
}
