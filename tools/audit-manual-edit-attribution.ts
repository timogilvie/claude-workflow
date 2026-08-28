#!/usr/bin/env -S npx tsx

/**
 * Backfill audit (HOK-2894): how many historical eval records carry
 * operator commits that were scored as model work by the pre-HOK-2894
 * manual-edit detector? Read-only — never rewrites eval records.
 *
 * Usage:
 *   npx tsx tools/audit-manual-edit-attribution.ts
 *   npx tsx tools/audit-manual-edit-attribution.ts --issue HOK-2888 --json
 *   npx tsx tools/audit-manual-edit-attribution.ts --limit 200
 */

import { fileURLToPath } from 'node:url';
import { auditManualEditAttribution } from '../shared/lib/manual-edit-attribution-audit.ts';
import { runTool, resolveRepoDir, type ParsedArgs } from '../shared/lib/tool-runner.ts';

const options = {
  json: { type: 'boolean', description: 'Print the full audit report as JSON' },
  limit: { type: 'string', description: 'Cap the number of eligible records audited' },
  issue: { type: 'string', description: 'Restrict the audit to a single Linear issue (e.g. HOK-2888)' },
  'repo-dir': { type: 'string', description: 'Repository directory' },
} as const;

type CliArgs = ParsedArgs<typeof options>;

function renderHumanSummary(report: ReturnType<typeof auditManualEditAttribution>): void {
  console.log(
    `Audited ${report.audited} eval record(s): ${report.cleanRecords} clean, `
      + `${report.suspectRecords} suspect (operator commits scored as model work), `
      + `${report.unknownRecords} unknown (no attribution data available).`,
  );
  console.log(`Total operator commits found: ${report.operatorCommits}`);

  const suspects = report.findings.filter((f) => f.classification === 'suspect');
  if (suspects.length === 0) {
    console.log('Suspect records: none');
    return;
  }
  console.log('Suspect records:');
  for (const finding of suspects) {
    console.log(
      `  ${finding.issueId ?? '(no issue)'}\tPR #${finding.prNumber}\tagentType=${finding.agentType ?? 'unknown'}`
        + `\toperatorCommits=${finding.operatorCommitShas.join(',')}`,
    );
  }
}

export async function runManualEditAttributionAuditCommand(args: CliArgs): Promise<number> {
  const repoDir = resolveRepoDir(args['repo-dir']);
  const limit = args.limit ? Number.parseInt(args.limit, 10) : undefined;
  if (args.limit && (!Number.isFinite(limit) || (limit as number) <= 0)) {
    console.error(`Invalid --limit value: ${args.limit}`);
    return 2;
  }

  const report = auditManualEditAttribution({ repoDir, issueId: args.issue, limit });

  renderHumanSummary(report);
  if (args.json === true) {
    console.log(JSON.stringify(report, null, 2));
  }
  return 0;
}

const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);
if (isMainModule) {
  await runTool<typeof options>({
    name: 'audit-manual-edit-attribution',
    description: 'Audit historical eval records for operator commits scored as model work (HOK-2894 backfill question)',
    options,
    examples: [
      'npx tsx tools/audit-manual-edit-attribution.ts',
      'npx tsx tools/audit-manual-edit-attribution.ts --issue HOK-2888 --json',
      'npx tsx tools/audit-manual-edit-attribution.ts --limit 200',
    ],
    async run({ args }) {
      const code = await runManualEditAttributionAuditCommand(args);
      if (code !== 0) {
        process.exit(code);
      }
    },
  });
}
