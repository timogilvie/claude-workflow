#!/usr/bin/env -S npx tsx
import { runTool } from '../shared/lib/tool-runner.ts';
import { getManifest } from '../shared/lib/resource-manifest.ts';
import { getResource, listResources } from '../shared/lib/resource-registry.ts';

function diffRefs(left: { id: string; version: string }[], right: { id: string; version: string }[]) {
  const leftSet = new Set(left.map((ref) => `${ref.id}@${ref.version}`));
  const rightSet = new Set(right.map((ref) => `${ref.id}@${ref.version}`));
  return {
    onlyLeft: [...leftSet].filter((entry) => !rightSet.has(entry)).sort(),
    onlyRight: [...rightSet].filter((entry) => !leftSet.has(entry)).sort(),
  };
}

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
        throw new Error('diff requires <session-a> <session-b>');
      }
      const left = getManifest(first, repoDir);
      const right = getManifest(second, repoDir);
      if (!left || !right) {
        throw new Error('Both manifests must exist');
      }
      console.log(JSON.stringify(diffRefs(left.resources, right.resources), null, 2));
      return;
    }

    throw new Error(`Unknown subcommand: ${subcommand || '(none)'}`);
  },
});
