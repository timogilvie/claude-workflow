#!/usr/bin/env -S npx tsx

import { readFileSync } from 'node:fs';
import { runTool } from '../shared/lib/tool-runner.ts';
import { certifyNativeAgent } from './native-agent-certify.ts';
import type { CertificationPhase } from '../shared/lib/native-agent/certification/index.ts';
import type { NativeProviderName } from '../shared/lib/model-registry.ts';

interface CertificationManifest {
  certs: Array<{
    provider: NativeProviderName;
    model: string;
    phase: CertificationPhase;
    reason?: string;
  }>;
}

runTool({
  name: 'run-bulk-certifications',
  description: 'Run native-agent certifications from a JSON manifest and publish successful artifacts globally.',
  options: {
    manifest: { type: 'string', description: 'Path to certification manifest JSON.' },
    repo: { type: 'string', description: 'Repository directory. Defaults to current working directory.' },
    'dry-run': { type: 'boolean', description: 'Run scenarios without writing artifacts.' },
    json: { type: 'boolean', description: 'Emit machine-readable JSON.' },
  },
  examples: [
    'npx tsx tools/run-bulk-certifications.ts --manifest .wavemill/certification-manifest.json',
    'npx tsx tools/run-bulk-certifications.ts --manifest .wavemill/certification-manifest.json --dry-run --json',
  ],
  async run({ args }) {
    const manifestPath = args.manifest as string | undefined;
    if (!manifestPath) {
      console.error('Error: --manifest is required');
      process.exit(2);
    }

    const repoDir = (args.repo as string | undefined) || process.cwd();
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as CertificationManifest;
    if (!manifest || !Array.isArray(manifest.certs)) {
      console.error('Error: manifest must contain a certs array');
      process.exit(2);
    }

    const results = [];
    for (const cert of manifest.certs) {
      try {
        const result = await certifyNativeAgent({
          provider: cert.provider,
          model: cert.model,
          phase: cert.phase,
          repoDir,
          dryRun: args['dry-run'] === true,
        });
        results.push({ ...cert, ok: result.harnessPassed, result });
      } catch (err) {
        results.push({
          ...cert,
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    if (args.json === true) {
      console.log(JSON.stringify({ results }, null, 2));
    } else {
      for (const entry of results) {
        console.log(`${entry.ok ? 'ok' : 'failed'} ${entry.provider}/${entry.model} phase=${entry.phase}`);
      }
    }

    process.exit(results.every((entry) => entry.ok) ? 0 : 1);
  },
});
