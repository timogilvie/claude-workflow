#!/usr/bin/env -S npx tsx

import { resolve } from 'node:path';
import { countRejectedEvalRecords, listRejectedEvalRecords } from '../shared/lib/eval-rejected-store.ts';
import { runTool } from '../shared/lib/tool-runner.ts';

runTool({
  name: 'eval-rejected',
  description: 'Inspect rejected eval quarantine records',
  options: {
    count: { type: 'boolean', description: 'Print only the rejected eval record count' },
    list: { type: 'boolean', description: 'List rejected eval quarantine files' },
    limit: { type: 'string', description: 'Maximum files to list' },
    'repo-dir': { type: 'string', description: 'Repository directory (default: current directory)' },
  },
  examples: [
    'npx tsx tools/eval-rejected.ts --count',
    'npx tsx tools/eval-rejected.ts --list --limit 10 --repo-dir /path/to/repo',
  ],
  run({ args }) {
    const repoDir = resolve(args['repo-dir'] ?? process.cwd());
    const count = countRejectedEvalRecords(repoDir);
    const shouldList = args.list === true;
    const shouldCountOnly = args.count === true || !shouldList;

    if (shouldCountOnly) {
      process.stdout.write(`${count}\n`);
      return;
    }

    const limit = parseLimit(args.limit);
    const paths = listRejectedEvalRecords(repoDir, { limit });
    process.stdout.write(`count=${count}\n`);
    for (const path of paths) {
      process.stdout.write(`${path}\n`);
    }
  },
});

function parseLimit(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error('--limit must be a non-negative integer');
  }
  return parsed;
}
