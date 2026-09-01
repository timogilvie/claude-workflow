#!/usr/bin/env -S npx tsx

import { runCertifyCommand } from './native-agent-certify.ts';
import { runImportCommand } from './native-agent-certifications-import.ts';
import { runInspectCommand } from './native-agent-certifications-inspect.ts';
import { runInvalidateCommand, runReidentifyCommand } from './native-agent-certifications-identity.ts';
import { runListCommand } from './native-agent-certifications-list.ts';
import { runPruneCommand } from './native-agent-certifications-prune.ts';
import { runVerifyCommand } from './native-agent-certifications-verify.ts';
import { runModelsReportCommand } from './native-agent-models-report.ts';

const SUBCOMMANDS = ['list', 'inspect', 'verify', 'report', 'certify', 're-certify', 'reidentify', 'invalidate', 'migrate', 'prune'] as const;

export async function runCertificationsCommand(argv = process.argv.slice(2)): Promise<void> {
  const [subcommand, ...rest] = argv;
  if (!subcommand || subcommand === '--help' || subcommand === '-h') {
    printHelp();
    return;
  }

  switch (subcommand) {
    case 'list':
      await runListCommand(rest);
      return;
    case 'inspect':
      await runInspectCommand(rest);
      return;
    case 'verify':
      await runVerifyCommand(rest);
      return;
    case 'report':
      await runModelsReportCommand(rest);
      return;
    case 'certify':
    case 're-certify':
      await runCertifyCommand(rest);
      return;
    case 'reidentify':
      await runReidentifyCommand(rest);
      return;
    case 'invalidate':
      await runInvalidateCommand(rest);
      return;
    case 'migrate':
      await runImportCommand(rest);
      return;
    case 'prune':
      await runPruneCommand(rest);
      return;
    default:
      console.error(`Error: unknown certifications subcommand "${subcommand}".`);
      console.error(`Expected one of: ${SUBCOMMANDS.join(', ')}`);
      process.exit(2);
  }
}

function printHelp(): void {
  console.log(`native-agent-certifications - Manage global native-agent certification artifacts.

Usage:
  wavemill native-agent certifications <subcommand> [options]

Subcommands:
  list         List global artifacts.
  inspect      Inspect one global artifact and derived TTL/eligibility.
  verify       Verify one global artifact without running live scenarios.
  report       Report registry models as not-certified, certified-unavailable, stale, or ready-for-challenge.
  certify      Run the live certification suite and publish a global artifact; use --all for the full matrix.
  re-certify   Alias for certify.
  reidentify   Dry-run identity change impact; --execute writes only an audit artifact.
  invalidate   Dry-run invalidation impact; --execute writes only an audit artifact.
  migrate      Inspect legacy repo-local artifacts; import only reusable current artifacts.
  prune        Report orphan artifacts; delete only with --yes.

Examples:
  wavemill native-agent certifications list --json
  wavemill native-agent certifications verify --provider openrouter --model qwen-3-coder --phase patch
  wavemill native-agent certifications certify --all --phase workflow
  wavemill native-agent certifications migrate --repo /path/to/repo --dry-run --json
  wavemill native-agent certifications prune --yes
`);
}

if (import.meta.main) {
  await runCertificationsCommand();
}
