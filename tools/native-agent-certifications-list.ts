#!/usr/bin/env -S npx tsx

import { relative } from 'node:path';
import { runTool } from '../shared/lib/tool-runner.ts';
import {
  listGlobalCertifications,
  readCertification,
  resolveGlobalCertificationRoot,
  type NativeCertificationArtifact,
} from '../shared/lib/native-agent/certification/index.ts';

export interface ListedCertification {
  provider: string;
  model: string;
  phase: string;
  suiteVersion: string;
  certifiedAt: string;
  expiresAt?: string;
  artifactPath: string;
  valid: boolean;
}

export function listGlobalCertificationArtifacts(opts: {
  provider?: string;
  model?: string;
  phase?: string;
} = {}): ListedCertification[] {
  const root = resolveGlobalCertificationRoot();
  const rows: ListedCertification[] = [];
  for (const artifactPath of listGlobalCertifications()) {
    const read = readCertification(artifactPath);
    if (!read.ok) continue;
    const artifact = read.artifact;
    if (opts.provider && artifact.provider !== opts.provider) continue;
    if (opts.model && artifact.model !== opts.model) continue;
    if (opts.phase && artifact.phase !== opts.phase) continue;
    rows.push(toListedCertification(artifact, artifactPath, root));
  }
  rows.sort((a, b) =>
    a.provider.localeCompare(b.provider)
    || a.model.localeCompare(b.model)
    || a.phase.localeCompare(b.phase)
    || a.suiteVersion.localeCompare(b.suiteVersion));
  return rows;
}

export function renderCertificationList(rows: ListedCertification[]): string {
  if (rows.length === 0) return 'No global native-agent certifications found.\n';
  const headers = ['Provider', 'Model', 'Phase', 'Suite', 'Certified At', 'Expires At', 'Path'];
  const body = rows.map(row => [
    row.provider,
    row.model,
    row.phase,
    row.suiteVersion,
    row.certifiedAt,
    row.expiresAt ?? '-',
    row.artifactPath,
  ]);
  const all = [headers, ...body];
  const widths = headers.map((_, idx) => Math.max(...all.map(row => row[idx]!.length)));
  return all.map(row => row.map((cell, idx) => cell.padEnd(widths[idx]!)).join('  ')).join('\n') + '\n';
}

export function runListCommand(argv = process.argv.slice(2)): Promise<void> {
  return runTool({
    name: 'native-agent-certifications list',
    description: 'List global native-agent certification artifacts.',
    options: {
      json: { type: 'boolean', description: 'Emit machine-readable JSON.' },
      provider: { type: 'string', description: 'Filter by canonical storage provider.' },
      model: { type: 'string', description: 'Filter by canonical storage model.' },
      phase: { type: 'string', description: 'Filter by phase.' },
    },
    examples: [
      'wavemill native-agent certifications list',
      'wavemill native-agent certifications list --provider qwen --json',
    ],
    async run({ args }) {
      const rows = listGlobalCertificationArtifacts({
        provider: args.provider as string | undefined,
        model: args.model as string | undefined,
        phase: args.phase as string | undefined,
      });
      if (args.json === true) {
        console.log(JSON.stringify({ root: resolveGlobalCertificationRoot(), certifications: rows }, null, 2));
      } else {
        process.stdout.write(renderCertificationList(rows));
      }
    },
  }, argv);
}

function toListedCertification(
  artifact: NativeCertificationArtifact,
  artifactPath: string,
  root: string,
): ListedCertification {
  return {
    provider: artifact.provider,
    model: artifact.model,
    phase: artifact.phase,
    suiteVersion: artifact.suiteVersion,
    certifiedAt: artifact.certifiedAt,
    ...(artifact.expiresAt ? { expiresAt: artifact.expiresAt } : {}),
    artifactPath: relative(root, artifactPath) || artifactPath,
    valid: true,
  };
}

if (import.meta.main) {
  await runListCommand();
}
