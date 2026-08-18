#!/usr/bin/env -S npx tsx

import { runTool } from '../shared/lib/tool-runner.ts';
import { auditHokusaiContributions, renderHokusaiAuditReport } from '../shared/lib/hokusai-audit.ts';
import {
  disableSubmission,
  enableSubmission,
  getContributionConsentStatus,
  getContributionStatus,
  getStatusDisplay,
  getSubmissionStatus,
} from '../shared/lib/hokusai-consent.ts';
import { summarizeHokusaiLedger } from '../shared/lib/hokusai-ledger.ts';
import {
  configureContributionUpload,
  ensureGitignoreEntry,
  migrateContributionEndpoint,
} from '../shared/lib/hokusai-local-config.ts';
import { hokusaiQueueStatus, requeueDeadLetterEntries, type RequeueReportEntry } from '../shared/lib/hokusai-queue.ts';
import { drainContributionQueue } from '../shared/lib/hokusai-queue-drain.ts';

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
    'dead-letter': { type: 'boolean', description: 'Requeue entries from the dead-letter queue' },
    'entry-id': { type: 'string', description: 'Only requeue a single dead-letter entry id' },
    since: { type: 'string', description: 'Only requeue dead-letter entries failed at or after this ISO timestamp' },
    'dry-run': { type: 'boolean', description: 'Preview changes without modifying queue files or config' },
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
    description: 'Command (enable|disable|status|check-consent|configure|migrate|drain|requeue|audit)',
  },
  examples: [
    'npx tsx tools/hokusai-manage.ts status',
    'npx tsx tools/hokusai-manage.ts enable',
    'npx tsx tools/hokusai-manage.ts disable',
    'npx tsx tools/hokusai-manage.ts check-consent',
    'npx tsx tools/hokusai-manage.ts configure',
    'npx tsx tools/hokusai-manage.ts migrate --dry-run',
    'npx tsx tools/hokusai-manage.ts drain',
    'npx tsx tools/hokusai-manage.ts requeue --dead-letter --dry-run',
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
        const contribStatus = getContributionStatus(options);
        const queue = hokusaiQueueStatus(options);
        const summary = summarizeHokusaiLedger(options);
        const historyReadOnly = !contributionConsent.submissionAllowed;
        const contributions = {
          consent: contribStatus.consent,
          queue: contribStatus.queue,
          uploadEndpoint: contribStatus.uploadEndpoint,
          mode: contribStatus.mode,
          endpoint: contribStatus.endpoint,
          endpointLooksUnscoped: contribStatus.endpointLooksUnscoped,
          warning: contribStatus.warning,
          pendingQueueCount: queue.pendingCount,
          deadLetterQueueCount: queue.deadLetterCount,
          lastQueueError: queue.lastError,
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
          console.log(`Dead-letter queue: ${contributions.deadLetterQueueCount}`);
          if (contributions.lastQueueError) {
            const failure = contributions.lastQueueError;
            console.log(`Last queue error: ${failure.code} (${failure.message}) at ${failure.at}`);
          }
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

      case 'requeue': {
        if (!args['dead-letter']) {
          throw new Error('requeue currently requires --dead-letter');
        }

        const result = await requeueDeadLetterEntries({
          entryId: args['entry-id'],
          since: args.since,
        }, {
          ...options,
          dryRun: !!args['dry-run'],
        });

        if (args.json) {
          console.log(JSON.stringify(result, null, 2));
          return;
        }

        const renderEntry = (entry: RequeueReportEntry) => {
          const status = entry.failureStatus === undefined ? '' : ` HTTP ${entry.failureStatus}`;
          return `  ${entry.entryId}  ${entry.failureCode}${status}  ${entry.failedAt}`;
        };
        const skippedNote = result.skippedMalformed > 0
          ? ` Preserved ${result.skippedMalformed} malformed dead-letter line${result.skippedMalformed === 1 ? '' : 's'}.`
          : '';

        switch (result.status) {
          case 'disabled':
            console.log('Contribution queue is disabled. Enable with `wavemill hokusai enable` and ensure hokusai.contributions.enabled is true in .wavemill-config.json.');
            break;
          case 'nothing_to_requeue':
            if (result.remaining === 0 && result.skippedMalformed === 0) {
              console.log('Dead-letter queue is empty. Nothing to requeue.');
            } else {
              console.log(`No matching entries found in dead-letter queue.${skippedNote}`);
            }
            break;
          case 'dry_run':
            console.log(`Would requeue ${result.requeued.length} of ${result.remaining} dead-lettered entr${result.remaining === 1 ? 'y' : 'ies'}:`);
            for (const entry of result.requeued) {
              console.log(renderEntry(entry));
            }
            if (skippedNote) {
              console.log(skippedNote.trim());
            }
            break;
          case 'requeued':
            console.log(`Requeued ${result.requeued.length} dead-lettered entr${result.requeued.length === 1 ? 'y' : 'ies'} back to pending. Run 'hokusai-manage drain' to resend.`);
            for (const entry of result.requeued) {
              console.log(renderEntry(entry));
            }
            if (skippedNote) {
              console.log(skippedNote.trim());
            }
            break;
        }
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

      case 'configure': {
        const repoDir = args['repo-dir'] ?? process.cwd();
        const result = configureContributionUpload({ repoDir });
        const gitignoreResult = ensureGitignoreEntry(repoDir, '.wavemill-config.local.json');
        if (args.json) {
          console.log(JSON.stringify({
            action: result.action,
            localConfigPath: result.localConfigPath,
            endpoint: result.endpoint,
            gitignore: gitignoreResult,
          }, null, 2));
        } else {
          if (result.action === 'unchanged') {
            console.log(`Contribution upload already configured in ${result.localConfigPath}`);
          } else {
            console.log(`${result.action === 'created' ? 'Created' : 'Updated'} ${result.localConfigPath} with Hokusai contribution upload settings`);
          }
          console.log(`  Upload endpoint: ${result.endpoint}`);
          console.log(`  Token env: HOKUSAI_API_TOKEN`);
          if (gitignoreResult === 'added') {
            console.log(`  Added .wavemill-config.local.json to .gitignore`);
          }
        }
        return;
      }

      case 'migrate': {
        const result = migrateContributionEndpoint({
          repoDir: args['repo-dir'] ?? process.cwd(),
          dryRun: !!args['dry-run'],
        });

        if (args.json) {
          console.log(JSON.stringify(result, null, 2));
          return;
        }

        switch (result.action) {
          case 'absent':
            console.log(`No local contribution overlay found at ${result.localConfigPath}.`);
            break;
          case 'unchanged':
            console.log(`Contribution endpoint overlay already does not use the legacy unscoped path: ${result.localConfigPath}`);
            break;
          case 'migrated':
            console.log(`${args['dry-run'] ? 'Would migrate' : 'Migrated'} contribution endpoint in ${result.localConfigPath}`);
            console.log(`  From: ${result.from}`);
            console.log(`  To: ${result.to}`);
            break;
        }
        return;
      }

      case 'drain': {
        const result = await drainContributionQueue(options);
        if (args.json) {
          console.log(JSON.stringify(result, null, 2));
        } else {
          switch (result.status) {
            case 'uploaded':
              console.log(`Uploaded ${result.uploadedCount ?? 0} contribution row${(result.uploadedCount ?? 0) === 1 ? '' : 's'} to Hokusai.${result.jobIds?.length ? ` Job IDs: ${result.jobIds.join(', ')}` : ''}`);
              break;
            case 'exported':
              console.log(`Exported ${result.exportedCount ?? 0} contribution row${(result.exportedCount ?? 0) === 1 ? '' : 's'} to local JSONL (export-only mode — no endpoint configured).`);
              break;
            case 'empty':
              console.log('Contribution queue is empty. Nothing to drain.');
              break;
            case 'waiting':
              console.log(`Queue is waiting for retry backoff. Next attempt: ${result.nextAttemptAt ?? 'unknown'}`);
              break;
            case 'disabled':
              console.log('Contribution queue is disabled. Enable with `wavemill hokusai enable` and ensure hokusai.contributions.enabled is true in .wavemill-config.json.');
              break;
            case 'unconfigured':
              console.log('No export path or upload endpoint configured. Add hokusai.contributions.endpoint to .wavemill-config.local.json or run `wavemill hokusai configure`.');
              break;
            case 'retry_scheduled':
              console.log(`Upload failed (transient). Retry scheduled at ${result.nextAttemptAt ?? 'unknown'}.${result.error ? ` Error: ${result.error}` : ''}`);
              break;
            case 'dead_lettered':
              console.log(`Upload retries exhausted. Batch moved to dead-letter.${result.error ? ` Last error: ${result.error}` : ''}`);
              process.exitCode = 1;
              break;
            case 'permanent_failure':
              console.log(`Upload failed permanently.${result.error ? ` Error: ${result.error}` : ''}`);
              process.exitCode = 1;
              break;
            case 'corrupt_state':
              console.log(`Queue state is corrupt.${result.error ? ` Details: ${result.error}` : ''}`);
              process.exitCode = 1;
              break;
            default:
              console.log(`Drain result: ${result.status}`);
          }
        }
        return;
      }

      default:
        throw new Error(
          `Unknown command "${command}"\nValid commands: enable, disable, status, check-consent, configure, migrate, drain, requeue, audit`,
        );
    }
  },
});
