#!/usr/bin/env -S npx tsx
import { runTool } from '../shared/lib/tool-runner.ts';
import { getManifest } from '../shared/lib/resource-manifest.ts';
import { getResource, listResources } from '../shared/lib/resource-registry.ts';
import {
  diffHarnesses,
  formatHarnessDiff,
  formatHarnessResources,
  resolveHarnessSelector,
} from '../shared/lib/harness-diff.ts';

runTool({
  name: 'registry',
  description: 'Inspect resource registry entries and per-run manifests',
  options: {
    type: { type: 'string', description: 'Filter resources by type' },
    json: { type: 'boolean', description: 'Print machine-readable JSON' },
    'repo-dir': { type: 'string', description: 'Repository directory override' },
  },
  positional: {
    name: 'subcommand args',
    description: 'Subcommand and arguments',
    multiple: true,
  },
  async run({ args, positional }) {
    const [subcommand, first, second] = positional;
    const repoDir = args['repo-dir'] as string | undefined;

    if (subcommand === 'list') {
      const resources = listResources(args.type ? { type: args.type as any } : {}, repoDir);
      console.log(JSON.stringify(resources, null, 2));
      return;
    }

    if (subcommand === 'show') {
      if (!first) {
        throw new Error('show requires <resource-id>');
      }
      const record = getResource(first, undefined, repoDir);
      if (!record) {
        throw new Error(`Resource not found: ${first}`);
      }
      console.log(JSON.stringify(record, null, 2));
      return;
    }

    if (subcommand === 'manifest') {
      if (!first) {
        throw new Error('manifest requires <session-id>');
      }
      const manifest = getManifest(first, repoDir);
      if (!manifest) {
        throw new Error(`Manifest not found: ${first}`);
      }
      console.log(JSON.stringify(manifest, null, 2));
      return;
    }

    if (subcommand === 'diff') {
      if (!first || !second) {
        throw new Error('diff requires <session-or-harness-a> <session-or-harness-b>');
      }
      const left = resolveHarnessSelector(first, repoDir);
      const right = resolveHarnessSelector(second, repoDir);
      const diff = diffHarnesses(left.resources, right.resources);
      if (args.json) {
        console.log(JSON.stringify({
          left: { selector: first, harnessId: left.harnessId, sessions: left.sessions },
          right: { selector: second, harnessId: right.harnessId, sessions: right.sessions },
          ...diff,
        }, null, 2));
      } else {
        console.log(formatHarnessDiff(left, right, diff));
      }
      return;
    }

    if (subcommand === 'harness') {
      if (!first) {
        throw new Error('harness requires <harness-id-or-session>');
      }
      const resolved = resolveHarnessSelector(first, repoDir);
      if (args.json) {
        console.log(JSON.stringify({
          selector: first,
          harnessId: resolved.harnessId,
          sessions: resolved.sessions,
          resources: resolved.resources,
        }, null, 2));
      } else {
        console.log(formatHarnessResources(resolved));
      }
      return;
    }

    throw new Error(`Unknown subcommand: ${subcommand || '(none)'}`);
  },
});
