#!/usr/bin/env -S npx tsx
/**
 * Diagnose Artifacts
 *
 * Read-only diagnostic tool that inspects normalized task artifacts
 * (task-contract.json, feature-state.json, trace.jsonl) and reports
 * coverage gaps, stale hashes, and inconsistencies against existing
 * controller state.
 *
 * Usage:
 *   npx tsx tools/diagnose-artifacts.ts [taskId]
 *   npx tsx tools/diagnose-artifacts.ts --slug <slug>
 *   npx tsx tools/diagnose-artifacts.ts --feature-dir <path>
 *   npx tsx tools/diagnose-artifacts.ts --json
 *   npx tsx tools/diagnose-artifacts.ts --strict
 *
 * @module diagnose-artifacts
 */

import { runTool } from '../shared/lib/tool-runner.ts';
import { diagnoseArtifacts, type ArtifactDiagnosticFinding } from '../shared/lib/artifact-diagnostics.ts';

const SEVERITY_PREFIX: Record<string, string> = {
  info: ' [info]',
  warn: ' [warn]',
  error: '[error]',
};

runTool({
  name: 'diagnose-artifacts',
  description: 'Inspect normalized task artifacts for coverage, freshness, and consistency',
  positional: {
    name: 'taskId',
    description: 'Optional Linear task ID (e.g. HOK-1234) to scope diagnostics',
    required: false,
  },
  options: {
    repo: {
      type: 'string',
      description: 'Repository root directory (default: current working directory)',
    },
    'feature-dir': {
      type: 'string',
      description: 'Direct path to the feature directory (overrides slug/taskId resolution)',
    },
    slug: {
      type: 'string',
      description: 'Feature slug to resolve the feature directory',
    },
    json: {
      type: 'boolean',
      description: 'Print the raw report as JSON instead of human-readable output',
    },
    strict: {
      type: 'boolean',
      description: 'Exit with code 1 when any error-severity finding is present',
    },
  },
  examples: [
    'npx tsx tools/diagnose-artifacts.ts HOK-1234',
    'npx tsx tools/diagnose-artifacts.ts --slug my-feature-slug',
    'npx tsx tools/diagnose-artifacts.ts --feature-dir features/my-feature',
    'npx tsx tools/diagnose-artifacts.ts --json',
    'npx tsx tools/diagnose-artifacts.ts --strict',
  ],
  run({ args, positional }) {
    const taskId = positional[0] as string | undefined;
    const repoDir = (args['repo'] as string | undefined) ?? process.cwd();
    const featureDir = args['feature-dir'] as string | undefined;
    const slug = args['slug'] as string | undefined;
    const asJson = args['json'] === true;
    const strict = args['strict'] === true;

    const report = diagnoseArtifacts({ repoDir, taskId, slug, featureDir });

    if (asJson) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      printHumanReport(report);
    }

    if (strict && report.summary.error > 0) {
      process.exitCode = 1;
    }
  },
});

function printHumanReport(report: ReturnType<typeof diagnoseArtifacts>): void {
  const { taskId, slug, featureDir, summary, findings, artifacts } = report;

  // Header
  const identity = taskId
    ? `${taskId}${slug ? ` (${slug})` : ''}`
    : slug ?? featureDir ?? 'unknown';
  console.log(`\nArtifact Diagnostics — ${identity}`);
  if (featureDir) {
    console.log(`Feature directory: ${featureDir}`);
  }
  console.log(`Generated: ${report.generatedAt}`);
  console.log();

  // Artifact presence
  console.log('Artifacts:');
  printArtifactLine('task-contract.json', artifacts.taskContract.present, artifacts.taskContract.malformed);
  printArtifactLine('feature-state.json', artifacts.featureState.present, artifacts.featureState.malformed);
  const traceLabel = artifacts.trace.malformedLines > 0
    ? `present (${artifacts.trace.malformedLines} malformed line(s))`
    : artifacts.trace.present ? 'present' : 'absent';
  console.log(`  trace.jsonl: ${traceLabel}`);
  console.log();

  // Summary
  console.log(`Summary: ${summary.info} info, ${summary.warn} warn, ${summary.error} error`);
  console.log();

  if (findings.length === 0) {
    console.log('No findings.');
    return;
  }

  // Group by severity
  const bySeverity: Record<string, ArtifactDiagnosticFinding[]> = {
    error: [],
    warn: [],
    info: [],
  };
  for (const f of findings) {
    (bySeverity[f.severity] ?? bySeverity.info).push(f);
  }

  for (const severity of ['error', 'warn', 'info'] as const) {
    const group = bySeverity[severity];
    if (!group || group.length === 0) continue;
    for (const f of group) {
      const prefix = SEVERITY_PREFIX[severity] ?? `[${severity}]`;
      let line = `${prefix} [${f.code}] ${f.message}`;
      if (f.file) line += `\n        file: ${f.file}`;
      if (f.reason) line += `\n      reason: ${f.reason}`;
      console.log(line);
    }
  }
}

function printArtifactLine(name: string, present: boolean, malformed: boolean): void {
  let status: string;
  if (!present) status = 'absent';
  else if (malformed) status = 'present (malformed)';
  else status = 'present';
  console.log(`  ${name}: ${status}`);
}
