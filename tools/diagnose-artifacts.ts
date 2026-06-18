#!/usr/bin/env -S npx tsx
/**
 * Diagnose Artifacts
 *
 * Read-only observer that inspects normalized task artifacts
 * (task-contract.json, feature-state.json, trace.jsonl) and reports
 * coverage, freshness, and inconsistencies against existing controller state.
 *
 * Always exits 0. Missing artifacts are reported as coverage gaps, not errors.
 *
 * Usage:
 *   npx tsx tools/diagnose-artifacts.ts
 *   npx tsx tools/diagnose-artifacts.ts --repo /path/to/repo
 *   npx tsx tools/diagnose-artifacts.ts --feature-dir features/my-feature
 *   npx tsx tools/diagnose-artifacts.ts --issue HOK-1234
 *   npx tsx tools/diagnose-artifacts.ts --json
 *   npx tsx tools/diagnose-artifacts.ts --all
 *
 * @module diagnose-artifacts
 */

import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { runTool } from '../shared/lib/tool-runner.ts';
import {
  diagnoseArtifacts,
  type DiagnosticFinding,
  type DiagnosticsResult,
} from '../shared/lib/artifact-diagnostics.ts';

// ── Formatting ───────────────────────────────────────────────────────────────

const SEVERITY_ICON: Record<string, string> = {
  ok: '✓',
  coverage: '○',
  stale: '⟳',
  malformed: '✗',
  mismatch: '⚠',
};

function formatFinding(finding: DiagnosticFinding): string {
  const icon = SEVERITY_ICON[finding.severity] ?? '?';
  const path = finding.filePath ? `\n    → ${finding.filePath}` : '';
  return `  ${icon} ${finding.check}: ${finding.severity} — ${finding.message}${path}`;
}

function formatResult(result: DiagnosticsResult): string {
  const lines: string[] = [];
  const label = result.featureDir || result.repoDir;
  lines.push(`\nArtifact Diagnostics — ${label}`);
  if (result.issueId) {
    lines.push(`  Issue: ${result.issueId}`);
  }
  lines.push('');
  for (const finding of result.findings) {
    lines.push(formatFinding(finding));
  }
  lines.push('');
  const s = result.summary;
  lines.push(
    `Summary: ${s.ok} ok, ${s.coverage} coverage, ${s.stale} stale, ${s.malformed} malformed, ${s.mismatch} mismatch`,
  );
  return lines.join('\n');
}

// ── CLI ──────────────────────────────────────────────────────────────────────

runTool({
  name: 'diagnose-artifacts',
  description: 'Inspect task artifacts and report coverage/freshness/inconsistencies',
  options: {
    repo: {
      type: 'string',
      description: 'Repository root directory (default: cwd)',
    },
    'feature-dir': {
      type: 'string',
      description: 'Diagnose a specific feature directory',
    },
    issue: {
      type: 'string',
      description: 'Filter to a specific issue ID',
    },
    all: {
      type: 'boolean',
      description: 'Scan all features/ subdirectories (default when no --feature-dir)',
    },
    json: {
      type: 'boolean',
      description: 'Output JSON instead of human-readable text',
    },
  },
  examples: [
    'npx tsx tools/diagnose-artifacts.ts',
    'npx tsx tools/diagnose-artifacts.ts --feature-dir features/my-feature',
    'npx tsx tools/diagnose-artifacts.ts --issue HOK-1234',
    'npx tsx tools/diagnose-artifacts.ts --all --json',
  ],
  async run({ args }) {
    const repoDir = resolve((args.repo as string | undefined) ?? process.cwd());
    const featureDirArg = args['feature-dir'] as string | undefined;
    const issueArg = args.issue as string | undefined;
    const outputJson = Boolean(args.json);
    const scanAll = Boolean(args.all) || !featureDirArg;

    process.exitCode = 0;

    // Collect feature directories to diagnose
    const targets: Array<{ featureDir: string; issueId?: string }> = [];

    if (featureDirArg) {
      targets.push({ featureDir: resolve(featureDirArg), issueId: issueArg });
    } else if (scanAll) {
      const featuresRoot = join(repoDir, 'features');
      if (!existsSync(featuresRoot)) {
        const coverage: DiagnosticsResult = {
          repoDir,
          featureDir: '',
          findings: [{
            check: 'feature-dirs-found',
            severity: 'coverage',
            message: 'No features/ directory found; nothing to diagnose',
            filePath: featuresRoot,
          }],
          summary: { ok: 0, coverage: 1, stale: 0, malformed: 0, mismatch: 0 },
        };
        if (outputJson) {
          console.log(JSON.stringify([coverage], null, 2));
        } else {
          console.log(formatResult(coverage));
        }
        return;
      }

      for (const entry of readdirSync(featuresRoot)) {
        const candidate = join(featuresRoot, entry);
        try {
          if (statSync(candidate).isDirectory()) {
            targets.push({ featureDir: candidate, issueId: issueArg });
          }
        } catch {
          // skip unreadable entries
        }
      }

      if (targets.length === 0) {
        const coverage: DiagnosticsResult = {
          repoDir,
          featureDir: '',
          findings: [{
            check: 'feature-dirs-found',
            severity: 'coverage',
            message: 'features/ directory is empty; nothing to diagnose',
            filePath: featuresRoot,
          }],
          summary: { ok: 0, coverage: 1, stale: 0, malformed: 0, mismatch: 0 },
        };
        if (outputJson) {
          console.log(JSON.stringify([coverage], null, 2));
        } else {
          console.log(formatResult(coverage));
        }
        return;
      }
    }

    // Run diagnostics on each target
    const results: DiagnosticsResult[] = [];
    for (const target of targets) {
      const result = await diagnoseArtifacts({
        repoDir,
        featureDir: target.featureDir,
        issueId: target.issueId,
      });
      results.push(result);
    }

    if (outputJson) {
      console.log(JSON.stringify(results.length === 1 ? results[0] : results, null, 2));
    } else {
      for (const result of results) {
        console.log(formatResult(result));
      }
    }
  },
});
