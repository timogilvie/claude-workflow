#!/usr/bin/env -S npx tsx

import { existsSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { runTool } from '../shared/lib/tool-runner.ts';
import {
  validateEvalsFile,
  validateEvalsStore,
  type ValidationIssue,
  type ValidationReport,
} from '../shared/lib/eval-validator.ts';

function parseMaxIssues(value: string | undefined): number {
  const parsed = Number(value ?? '50');
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`--max-issues must be a non-negative integer, got ${value}`);
  }
  return parsed;
}

async function resolveReport(target?: string): Promise<ValidationReport> {
  if (!target) {
    return validateEvalsStore(process.cwd());
  }

  const resolved = resolve(target);
  if (!existsSync(resolved)) {
    throw new Error(`Path not found: ${resolved}`);
  }

  const stats = statSync(resolved);
  if (stats.isDirectory()) {
    const evalsFile = join(resolved, 'evals.jsonl');
    if (existsSync(evalsFile)) {
      return validateEvalsFile(evalsFile);
    }
    return validateEvalsStore(resolved);
  }

  return validateEvalsFile(resolved);
}

function formatIssue(issue: ValidationIssue): string {
  const location = `${basename(issue.file)}:${issue.line}`;
  const code = issue.code.padEnd(25);
  const detail = issue.detail || '-';
  return `  ${location.padEnd(18)} ${code} ${detail}`;
}

function printTextReport(report: ValidationReport, maxIssues: number): void {
  const source = report.files[0] || '<none>';
  console.log(`Validation Report: ${source}`);
  console.log(`  Lines scanned: ${report.totalLines}`);
  console.log(`  Valid records: ${report.validRecords}`);
  console.log(`  Issues found: ${report.issues.length}`);
  console.log('');

  console.log('By error code:');
  if (Object.keys(report.countsByCode).length === 0) {
    console.log('  none');
  } else {
    for (const [code, count] of Object.entries(report.countsByCode).sort()) {
      console.log(`  ${code.padEnd(28)} ${count}`);
    }
  }

  console.log('');
  const visibleIssues = report.issues.slice(0, maxIssues);
  console.log(`Issues (first ${visibleIssues.length}):`);
  if (visibleIssues.length === 0) {
    console.log('  none');
    return;
  }

  console.log('  file:line          CODE                      detail');
  for (const issue of visibleIssues) {
    console.log(formatIssue(issue));
  }
}

runTool({
  name: 'validate-evals',
  description: 'Validate eval JSONL files and report malformed or ineligible records',
  options: {
    json: {
      type: 'boolean',
      description: 'Output JSON instead of human-readable text',
    },
    'max-issues': {
      type: 'string',
      description: 'Maximum number of issues to display',
      default: '50',
    },
    'exit-nonzero-on-issues': {
      type: 'boolean',
      description: 'Exit with status 1 when issues are found',
    },
  },
  positional: {
    name: 'path',
    description: 'Optional evals file path or repo/evals directory',
  },
  examples: [
    'npx tsx tools/validate-evals.ts',
    'npx tsx tools/validate-evals.ts .wavemill/evals/evals.jsonl',
    'npx tsx tools/validate-evals.ts --json --exit-nonzero-on-issues',
  ],
  async run({ args, positional }) {
    const report = await resolveReport(positional[0]);
    const maxIssues = parseMaxIssues(args['max-issues'] as string | undefined);
    const visibleIssues = report.issues.slice(0, maxIssues);

    if (args.json) {
      console.log(
        JSON.stringify(
          {
            ...report,
            issues: visibleIssues,
            maxIssues,
            truncated: report.issues.length > visibleIssues.length,
          },
          null,
          2,
        ),
      );
    } else {
      printTextReport(report, maxIssues);
    }

    if (args['exit-nonzero-on-issues'] && report.issues.length > 0) {
      process.exitCode = 1;
    }
  },
});
