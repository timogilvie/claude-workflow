#!/usr/bin/env -S npx tsx

import { runTool } from '../shared/lib/tool-runner.ts';
import { auditHokusaiContributions, renderHokusaiAuditReport } from '../shared/lib/hokusai-audit.ts';
import {
  disableSubmission,
  enableSubmission,
  getContributionConsentStatus,
  getStatusDisplay,
  getSubmissionStatus,
} from '../shared/lib/hokusai-consent.ts';
import { summarizeHokusaiLedger } from '../shared/lib/hokusai-ledger.ts';
import { hokusaiQueueStatus } from '../shared/lib/hokusai-queue.ts';

function parseOptionalNumber(value: string | undefined, name: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid numeric value for --${name}: ${value}`);
  }

  return parsed;
}

runTool({
  name: 'hokusai-manage',
  description: 'Manage Hokusai data submission opt-in',
  options: {
    json: { type: 'boolean', description: 'Output status as JSON when supported' },
    yes: { type: 'boolean', description: 'Skip the interactive consent prompt when enabling' },
    'config-dir': { type: 'string', description: 'Override the user config directory (defaults to ~/.wavemill)' },
    'repo-dir': { type: 'string', description: 'Override the repo directory used to read .wavemill-config.json' },
    input: { type: 'string', description: 'JSONL file to audit instead of the local pending queue' },
    queue: { type: 'boolean', description: 'Audit the local pending queue (.wavemill/hokusai/queue/pending.jsonl)' },
    'coverage-threshold': { type: 'string', description: 'Candidate-pool coverage threshold between 0 and 1' },
    'max-invalid-rate': { type: 'string', description: 'Maximum allowed conformance-invalid rate between 0 and 1' },
    'threshold-mode': { type: 'string', description: 'Threshold handling mode: warn or fail' },
    'low-budget-threshold': { type: 'string', description: 'Budget threshold in USD for low-budget scenario inference' },
    'sparse-cell-min-evidence': { type: 'string', description: 'Minimum row count before a cell stops counting as sparse' },
  },
  positional: {
    name: 'command',
    required: true,
    multiple: true,
    description: 'Command (enable|disable|status|check-consent)',
  },
  examples: [
    'npx tsx tools/hokusai-manage.ts status',
    'npx tsx tools/hokusai-manage.ts enable',
    'npx tsx tools/hokusai-manage.ts disable',
    'npx tsx tools/hokusai-manage.ts check-consent',
    'npx tsx tools/hokusai-manage.ts audit --input path/to/contributions.jsonl --json',
  ],
  async run({ args, positional }) {
    const command = positional[0];
    const options = {
      configDir: args['config-dir'],
      repoDir: args['repo-dir'],
    };

    switch (command) {
      case 'enable': {
        const enabled = await enableSubmission({
          ...options,
          skipPrompt: !!args.yes,
        });
        const status = getSubmissionStatus(options);
        if (args.json) {
          console.log(JSON.stringify(status, null, 2));
        } else if (enabled) {
          console.log(getStatusDisplay(options));
        } else {
          console.log('Hokusai data submission remains disabled.');
        }
        process.exitCode = enabled ? 0 : 1;
        return;
      }

      case 'disable': {
        disableSubmission(args['config-dir']);
        if (args.json) {
          console.log(JSON.stringify(getSubmissionStatus(options), null, 2));
        } else {
          console.log(getStatusDisplay(options));
        }
        return;
      }

      case 'status': {
        const status = getSubmissionStatus(options);
        const contributionConsent = getContributionConsentStatus(options);
        const queue = hokusaiQueueStatus(options);
        const summary = summarizeHokusaiLedger(options);
        const historyReadOnly = !contributionConsent.submissionAllowed;
        const contributions = {
          pendingQueueCount: queue.pendingCount,
          acceptedSubmissionCount: summary.acceptedSubmissionCount,
          acceptedRowCount: summary.acceptedRowCount,
          rejectedSubmissionCount: summary.rejectedSubmissionCount,
          lastSubmission: summary.lastSubmission,
          tokenRewards: summary.tokenRewards,
          historyReadOnly,
        };
        if (args.json) {
          console.log(JSON.stringify({ ...status, contributions }, null, 2));
        } else {
          console.log(getStatusDisplay(options));
          console.log(`Pending queue: ${contributions.pendingQueueCount}`);
          console.log(`Accepted submissions: ${contributions.acceptedSubmissionCount}`);
          console.log(`Accepted rows: ${contributions.acceptedRowCount}`);
          if (contributions.lastSubmission) {
            console.log(`Last submission: ${contributions.lastSubmission.timestamp} jobId=${contributions.lastSubmission.jobId ?? 'none'} status=${contributions.lastSubmission.status}`);
          } else {
            console.log('Last submission: none');
          }
          console.log(
            `Rewards: awarded=${contributions.tokenRewards.awarded} pending=${contributions.tokenRewards.pending} none=${contributions.tokenRewards.none} unknown=${contributions.tokenRewards.unknown}`,
          );
          if (historyReadOnly && (summary.acceptedSubmissionCount > 0 || summary.rejectedSubmissionCount > 0)) {
            console.log('Contributions disabled; showing read-only local history.');
          }
        }
        return;
      }

      case 'check-consent': {
        const status = getSubmissionStatus(options);
        if (args.json) {
          console.log(JSON.stringify(status, null, 2));
        }
        process.exitCode = status.submissionAllowed ? 0 : 1;
        return;
      }

      case 'audit': {
        const coverageThreshold = parseOptionalNumber(args['coverage-threshold'], 'coverage-threshold');
        const maxInvalidRate = parseOptionalNumber(args['max-invalid-rate'], 'max-invalid-rate');
        const lowBudgetThresholdUsd = parseOptionalNumber(args['low-budget-threshold'], 'low-budget-threshold');
        const sparseCellMinEvidence = parseOptionalNumber(args['sparse-cell-min-evidence'], 'sparse-cell-min-evidence');
        const report = auditHokusaiContributions({
          repoDir: args['repo-dir'],
          inputPath: args.input,
          queue: args.queue,
          coverageThreshold,
          maxInvalidRate,
          lowBudgetThresholdUsd,
          sparseCellMinEvidence,
          thresholdMode: args['threshold-mode'] === 'fail' ? 'fail' : 'warn',
        });

        if (args.json) {
          console.log(JSON.stringify(report, null, 2));
        } else {
          process.stdout.write(renderHokusaiAuditReport(report));
        }

        process.exitCode = report.failures.length > 0 ? 1 : 0;
        return;
      }

      default:
        throw new Error(
          `Unknown command "${command}"\nValid commands: enable, disable, status, check-consent, audit`,
        );
    }
  },
});
