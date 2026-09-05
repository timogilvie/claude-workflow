#!/usr/bin/env -S npx tsx

import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getIncidentConfig } from '../shared/lib/config.ts';
import { IncidentStore } from '../shared/lib/wavemill-incident-store.ts';
import type { IncidentRecord } from '../shared/lib/wavemill-incident-model.ts';
import { runTool, resolveRepoDir, type ParsedArgs } from '../shared/lib/tool-runner.ts';

const ACTIONS = ['list', 'resolve', 'archive'] as const;
type IncidentAction = typeof ACTIONS[number];

const options = {
  'repo-dir': { type: 'string', description: 'Repository directory that owns the incident store' },
  reason: { type: 'string', description: 'Operator-facing reason recorded with resolve/archive' },
  all: { type: 'boolean', description: 'List all lifecycles, including resolved and archived records' },
  json: { type: 'boolean', description: 'Emit JSON output' },
} as const;

type CliArgs = ParsedArgs<typeof options>;

export function incidentStoreFor(repoDir: string): IncidentStore {
  const incidentConfig = getIncidentConfig(repoDir);
  const storeDir = incidentConfig.store?.directory ?? '.wavemill/incidents';
  return new IncidentStore(
    isAbsolute(storeDir) ? storeDir : join(repoDir, storeDir),
    {
      escalationThreshold: incidentConfig.detection?.dependencyThreshold ?? 3,
      maxEvidencePerRecord: incidentConfig.detection?.maxEvidencePerRecord ?? 50,
      resolutionAfterCycles: incidentConfig.detection?.resolutionAfterCycles ?? 5,
    },
  );
}

function formatRecord(record: IncidentRecord): string {
  const recurred = record.metadata?.recurrence
    ? ` recurred=${record.metadata.recurrence.count}x(last ${record.metadata.recurrence.lastRecurredAt})`
    : '';
  return [
    `[${record.lifecycle}/${record.severity}/${record.category}] ${record.summary}`,
    `  fingerprint: ${record.fingerprint}`,
    `  task: ${record.taskId ?? '(repo)'}`,
    `  rootCause: ${record.rootCauseClass}`,
    `  firstObserved: ${record.firstObservedAt || record.createdAt || 'unknown'}  lastObserved: ${record.lastObservedAt}`,
    `  distinctOccurrences: ${record.occurrenceCount}${recurred}`,
  ].join('\n');
}

export async function runIncidentsCommand(args: CliArgs, positional: string[]): Promise<void> {
  const action = (positional[0] ?? 'list') as IncidentAction;
  if (!ACTIONS.includes(action)) {
    throw new Error(`unknown action '${positional[0]}'; expected one of: ${ACTIONS.join(', ')}`);
  }
  const repoDir = resolveRepoDir(args['repo-dir']);
  const store = incidentStoreFor(repoDir);

  if (action === 'list') {
    const records = args.all ? await store.getAllIncidents() : await store.getIncidents();
    if (args.json) {
      console.log(JSON.stringify(records, null, 2));
      return;
    }
    if (records.length === 0) {
      console.log(args.all ? 'No incidents recorded.' : 'No observed/active incidents.');
      return;
    }
    console.log(records.map(formatRecord).join('\n\n'));
    return;
  }

  const fingerprint = positional[1];
  if (!fingerprint) {
    throw new Error(`${action} requires an incident fingerprint (see 'incidents list')`);
  }
  const updated = action === 'resolve'
    ? await store.resolve(fingerprint, { reason: args.reason })
    : await store.archive(fingerprint, { reason: args.reason });
  if (!updated) {
    throw new Error(`no incident found for fingerprint ${fingerprint}`);
  }
  if (args.json) {
    console.log(JSON.stringify(updated, null, 2));
    return;
  }
  console.log(`Incident ${fingerprint} marked ${updated.lifecycle}${args.reason ? ` (reason: ${args.reason})` : ''}.`);
  console.log('A new distinct event for this fingerprint will reopen the record with recurrence metadata.');
}

export async function runIncidentsCli(argv: string[] = process.argv.slice(2)): Promise<void> {
  await runTool({
    name: 'incidents',
    description: 'List, resolve, or archive Wavemill incidents without hand-editing the index',
    options,
    positional: {
      name: 'action [fingerprint]',
      description: `Action: ${ACTIONS.join(' | ')} (default: list); resolve/archive take a fingerprint`,
      multiple: true,
    },
    examples: [
      'npx tsx tools/incidents.ts list --repo-dir ~/repo',
      'npx tsx tools/incidents.ts list --all --json',
      'npx tsx tools/incidents.ts resolve <fingerprint> --reason "fixed by HOK-1234"',
      'npx tsx tools/incidents.ts archive <fingerprint> --repo-dir ~/repo',
    ],
    run: ({ args, positional }) => runIncidentsCommand(args, positional),
  }, argv);
}

const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);
if (isMainModule) {
  await runIncidentsCli();
}
