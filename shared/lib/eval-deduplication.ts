import { copyFileSync, writeFileSync } from 'node:fs';
import type { EvalRecord } from './eval-schema.ts';

export interface DeduplicationResult {
  totalRecords: number;
  uniqueRecords: number;
  duplicatesRemoved: number;
  duplicateGroups: Map<string, EvalRecord[]>;
  deduplicatedRecords: EvalRecord[];
}

function getRecordKey(record: EvalRecord): string {
  return `${record.issueId || 'no-issue'}|${record.prUrl || 'no-pr'}`;
}

export function deduplicateEvalRecords(records: EvalRecord[]): DeduplicationResult {
  const groups = new Map<string, EvalRecord[]>();

  for (const record of records) {
    const key = getRecordKey(record);
    if (!groups.has(key)) {
      groups.set(key, []);
    }
    groups.get(key)!.push(record);
  }

  const duplicateGroups = new Map<string, EvalRecord[]>();
  const deduplicatedRecords: EvalRecord[] = [];

  for (const [key, group] of groups) {
    const sortedGroup = [...group].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    if (sortedGroup.length > 1) {
      duplicateGroups.set(key, sortedGroup);
    }
    deduplicatedRecords.push(sortedGroup[0]);
  }

  return {
    totalRecords: records.length,
    uniqueRecords: deduplicatedRecords.length,
    duplicatesRemoved: records.length - deduplicatedRecords.length,
    duplicateGroups,
    deduplicatedRecords,
  };
}

export function formatDuplicateReport(result: DeduplicationResult): string {
  const lines = ['', 'Duplicates found for the following issue+PR combinations:', ''];

  for (const [key, records] of result.duplicateGroups) {
    const [issueId, prUrlRaw] = key.split('|');
    const prUrl = prUrlRaw === 'no-pr' ? '(no PR)' : prUrlRaw;
    const prNumber = prUrl.match(/\/pull\/(\d+)$/)?.[1] || prUrl;
    const earliest = records[0].timestamp;
    lines.push(`  ${issueId} + ${prNumber}: ${records.length} records → keeping earliest (${earliest})`);
  }

  return lines.join('\n');
}

export function writeEvalRecordsFile(filePath: string, records: EvalRecord[]): void {
  const sorted = [...records].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  const content = sorted.map((record) => JSON.stringify(record)).join('\n') + '\n';
  writeFileSync(filePath, content, 'utf-8');
}

export function createEvalBackup(filePath: string, now: Date = new Date()): string {
  const timestamp = now.toISOString().replace(/:/g, '-').replace(/\.\d+Z$/, 'Z');
  const backupPath = `${filePath}.backup-${timestamp}`;
  copyFileSync(filePath, backupPath);
  return backupPath;
}
