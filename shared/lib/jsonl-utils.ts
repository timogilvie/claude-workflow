import { readFileSync } from 'node:fs';

/**
 * Read a JSONL file into typed records.
 *
 * Blank lines and malformed JSON entries are skipped.
 */
export function readJsonlFile<T>(path: string): T[] {
  const content = readFileSync(path, 'utf-8');
  const records: T[] = [];

  for (const line of content.split('\n')) {
    if (!line.trim()) continue;

    try {
      records.push(JSON.parse(line) as T);
    } catch {
      // Skip malformed JSONL entries.
    }
  }

  return records;
}
