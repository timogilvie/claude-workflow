#!/usr/bin/env -S npx tsx

import { existsSync, statSync } from 'node:fs';
import { runTool } from '../shared/lib/tool-runner.ts';
import {
  buildGlobalCertificationPath,
  checkGlobalCertificationEligibility,
  listCertifications,
  listGlobalCertifications,
  readCertification,
  resolveCertificationStorageIdentity,
  type CertificationPhase,
} from '../shared/lib/native-agent/certification/index.ts';
import { DEFAULT_CERTIFICATION_SUITE_VERSION } from '../shared/lib/native-agent/certification/scenarios.ts';
import { evaluateMigrationEligibility } from '../shared/lib/native-agent/certification/migration.ts';
import { certifyNativeAgent } from './native-agent-certify.ts';
import type { NativeProviderName } from '../shared/lib/model-registry.ts';

type Command = 'list' | 'inspect' | 'verify' | 'refresh' | 'migrate';

const PHASES: readonly CertificationPhase[] = ['read-only', 'patch', 'workflow'];
const PROVIDERS: readonly NativeProviderName[] = ['openai', 'openrouter'];

runTool({
  name: 'native-agent-certifications',
  description: 'List, inspect, verify, refresh, and inspect migration status for global native-agent certifications.',
  options: {
    json: { type: 'boolean', description: 'Emit machine-readable JSON.' },
    provider: { type: 'string', description: 'Provider for inspect/verify/refresh or list filter.' },
    model: { type: 'string', description: 'Model for inspect/verify/refresh or list filter.' },
    phase: { type: 'string', description: 'Required phase for verify/refresh.' },
    suite: { type: 'string', description: `Suite version. Defaults to ${DEFAULT_CERTIFICATION_SUITE_VERSION}.` },
    repo: { type: 'string', description: 'Repository directory for registry and migration scans. Defaults to cwd.' },
    'dry-run': { type: 'boolean', description: 'For refresh, run without writing a certification artifact.' },
    inspect: { type: 'boolean', description: 'For migrate, inspect legacy artifacts without importing.' },
  },
  positional: {
    name: 'command',
    description: 'One of: list, inspect, verify, refresh, migrate.',
    required: true,
  },
  examples: [
    'npx tsx tools/native-agent-certifications.ts list',
    'npx tsx tools/native-agent-certifications.ts inspect --provider openrouter --model qwen-3-coder',
    'npx tsx tools/native-agent-certifications.ts verify --provider openrouter --model glm-5.2 --phase patch',
    'npx tsx tools/native-agent-certifications.ts refresh --provider openrouter --model kimi-k2.7-code --phase patch',
    'npx tsx tools/native-agent-certifications.ts migrate --inspect --json',
  ],
  async run({ args, positional }) {
    const command = positional[0] as Command;
    const repoDir = (args.repo as string | undefined) || process.cwd();
    const suite = (args.suite as string | undefined) || DEFAULT_CERTIFICATION_SUITE_VERSION;

    switch (command) {
      case 'list': {
        const rows = listGlobalCertifications()
          .map((path) => ({ path, read: readCertification(path) }))
          .filter(({ read }) => {
            if (!read.ok) return true;
            if (args.provider && read.artifact.provider !== args.provider) return false;
            if (args.model && read.artifact.model !== args.model) return false;
            return true;
          })
          .map(({ path, read }) => read.ok
            ? {
                path,
                provider: read.artifact.provider,
                model: read.artifact.model,
                phase: read.artifact.phase,
                suiteVersion: read.artifact.suiteVersion,
                certifiedAt: read.artifact.certifiedAt,
              }
            : { path, error: read.error.code });
        if (args.json === true) {
          console.log(JSON.stringify({ certifications: rows }, null, 2));
        } else {
          renderRows(rows);
        }
        return;
      }

      case 'inspect': {
        const provider = requiredString(args.provider, '--provider');
        const model = requiredString(args.model, '--model');
        const path = buildGlobalCertificationPath(provider, model, suite);
        const read = readCertification(path);
        if (!read.ok) {
          console.error(`Error: ${read.error.code}: ${read.error.message}`);
          process.exit(read.error.code === 'not-found' ? 1 : 2);
        }
        console.log(JSON.stringify({ path, artifact: read.artifact }, null, 2));
        return;
      }

      case 'verify': {
        const provider = requiredString(args.provider, '--provider');
        const model = requiredString(args.model, '--model');
        const phase = requiredPhase(args.phase as string | undefined);
        const result = checkGlobalCertificationEligibility(provider, model, suite, phase);
        const payload = { provider, model, suiteVersion: suite, requiredPhase: phase, ...result };
        if (args.json === true) {
          console.log(JSON.stringify(payload, null, 2));
        } else if (result.eligible) {
          console.log(`ready-for-challenge ${provider}/${model} phase=${phase} artifact=${result.artifactPath ?? ''}`);
        } else {
          console.log(`${statusFromReason(result.reason)} ${provider}/${model} phase=${phase} reason=${result.reason} artifact=${result.artifactPath ?? ''}`);
        }
        process.exit(result.eligible ? 0 : 1);
      }

      case 'refresh': {
        const provider = requiredProvider(args.provider as string | undefined);
        const model = requiredString(args.model, '--model');
        const phase = requiredPhase(args.phase as string | undefined);
        const result = await certifyNativeAgent({
          provider,
          model,
          phase,
          repoDir,
          dryRun: args['dry-run'] === true,
        });
        console.log(JSON.stringify(result, null, 2));
        process.exit(result.harnessPassed ? 0 : 1);
      }

      case 'migrate': {
        const paths = listCertifications(repoDir);
        const inspections = paths.map((path) => evaluateMigrationEligibility({
          path,
          sizeBytes: safeSize(path),
          globalArtifactExists: existsSync,
        }));
        if (args.json === true) {
          console.log(JSON.stringify({ scanned: inspections.length, inspections }, null, 2));
        } else {
          for (const item of inspections) {
            console.log(`${item.decision} ${item.path} ${item.provider ?? '?'} / ${item.model ?? '?'} ${item.suiteVersion ?? '?'} - ${item.reason}`);
          }
          if (inspections.length === 0) console.log('No legacy repo-local certification artifacts found.');
        }
        return;
      }

      default:
        console.error(`Error: unknown command "${String(command)}"`);
        process.exit(2);
    }
  },
});

function requiredString(value: unknown, flag: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    console.error(`Error: ${flag} is required`);
    process.exit(2);
  }
  return value;
}

function requiredProvider(value: string | undefined): NativeProviderName {
  const provider = requiredString(value, '--provider');
  if (!PROVIDERS.includes(provider as NativeProviderName)) {
    console.error(`Error: --provider must be one of: ${PROVIDERS.join(', ')}`);
    process.exit(2);
  }
  return provider as NativeProviderName;
}

function requiredPhase(value: string | undefined): CertificationPhase {
  const phase = requiredString(value, '--phase');
  if (!PHASES.includes(phase as CertificationPhase)) {
    console.error(`Error: --phase must be one of: ${PHASES.join(', ')}`);
    process.exit(2);
  }
  return phase as CertificationPhase;
}

function statusFromReason(reason: string): string {
  if (reason === 'missing') return 'not-certified';
  if (reason === 'stale') return 'stale';
  return 'certified-but-runtime-unavailable';
}

function safeSize(path: string): number | undefined {
  try {
    return statSync(path).size;
  } catch {
    return undefined;
  }
}

function renderRows(rows: Array<Record<string, unknown>>): void {
  if (rows.length === 0) {
    console.log('No global certification artifacts found.');
    return;
  }
  for (const row of rows) {
    if (typeof row.error === 'string') {
      console.log(`invalid ${row.path}: ${row.error}`);
      continue;
    }
    const identity = resolveCertificationStorageIdentity(String(row.provider), String(row.model));
    console.log(`${identity.provider}/${identity.model} phase=${row.phase} suite=${row.suiteVersion} certifiedAt=${row.certifiedAt} path=${row.path}`);
  }
}
