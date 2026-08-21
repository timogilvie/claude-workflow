#!/usr/bin/env -S npx tsx
import { fileURLToPath } from 'node:url';
import { readdirSync } from 'node:fs';
import { runTool } from '../shared/lib/tool-runner.ts';
import {
  getManifest,
  resolveHarnessId,
  computeHarnessId,
  harnessRefParticipates,
  resolveManifestDir,
  type ResourceManifest,
  type ResourceRef,
} from '../shared/lib/resource-manifest.ts';
import { getResource, listResources } from '../shared/lib/resource-registry.ts';

export interface DiffTarget {
  manifest: ResourceManifest;
  sessionId: string;
  harnessId: string;
  resolvedByHarnessId: boolean;
}

export interface DiffEntry {
  id: string;
  left: string;
  right: string;
}

export interface DiffResult {
  changed: DiffEntry[];
  onlyLeft: string[];
  onlyRight: string[];
}

function looksLikeHarnessId(value: string): boolean {
  return /^[0-9a-f]{8,64}$/.test(value);
}

function shortHarnessId(id: string): string {
  return id.slice(0, 12);
}

function resourceBaseId(ref: ResourceRef): string {
  const suffix = `@${ref.version}`;
  return ref.id.endsWith(suffix) ? ref.id.slice(0, ref.id.length - suffix.length) : ref.id;
}

function collectManifests(repoDir?: string): Array<{ manifest: ResourceManifest; sessionId: string; harnessId: string }> {
  const dir = resolveManifestDir(repoDir);
  const results: Array<{ manifest: ResourceManifest; sessionId: string; harnessId: string }> = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return results;
  }
  for (const entry of entries) {
    if (!entry.endsWith('.json')) {
      continue;
    }
    const sessionId = entry.slice(0, -5);
    const manifest = getManifest(sessionId, repoDir);
    if (!manifest) {
      continue;
    }
    results.push({ manifest, sessionId, harnessId: resolveHarnessId(sessionId, repoDir) ?? computeHarnessId(manifest.resources) });
  }
  return results;
}

function findManifestsByHarnessId(harnessIdOrPrefix: string, repoDir?: string): Array<{ manifest: ResourceManifest; sessionId: string; harnessId: string }> {
  const exact = harnessIdOrPrefix.length === 64;
  return collectManifests(repoDir).filter((item) =>
    exact ? item.harnessId === harnessIdOrPrefix : item.harnessId.startsWith(harnessIdOrPrefix),
  );
}

export function resolveDiffTarget(arg: string, repoDir?: string): DiffTarget {
  const manifest = getManifest(arg, repoDir);
  if (manifest) {
    return {
      manifest,
      sessionId: arg,
      harnessId: resolveHarnessId(arg, repoDir) ?? computeHarnessId(manifest.resources),
      resolvedByHarnessId: false,
    };
  }
  if (!looksLikeHarnessId(arg)) {
    throw new Error(`Manifest not found: ${arg}`);
  }
  const matches = findManifestsByHarnessId(arg, repoDir);
  if (matches.length === 0) {
    throw new Error(`Unknown harness id: ${arg}`);
  }
  if (matches.length > 1) {
    throw new Error(
      `Ambiguous harness id prefix ${arg} matches sessions: ${matches.map((m) => m.sessionId).join(', ')}`,
    );
  }
  return {
    manifest: matches[0].manifest,
    sessionId: matches[0].sessionId,
    harnessId: matches[0].harnessId,
    resolvedByHarnessId: true,
  };
}

export function diffHarnessRefs(left: ResourceRef[], right: ResourceRef[]): DiffResult {
  const leftMap = new Map<string, string>();
  const rightMap = new Map<string, string>();
  for (const ref of left) {
    leftMap.set(resourceBaseId(ref), ref.version);
  }
  for (const ref of right) {
    rightMap.set(resourceBaseId(ref), ref.version);
  }
  const ids = [...new Set([...leftMap.keys(), ...rightMap.keys()])].sort();
  const changed: DiffEntry[] = [];
  const onlyLeft: string[] = [];
  const onlyRight: string[] = [];
  for (const id of ids) {
    const lv = leftMap.get(id);
    const rv = rightMap.get(id);
    if (lv && rv && lv !== rv) {
      changed.push({ id, left: lv, right: rv });
    } else if (lv && !rv) {
      onlyLeft.push(id);
    } else if (rv && !lv) {
      onlyRight.push(id);
    }
  }
  return { changed, onlyLeft, onlyRight };
}

function groupByType(ids: string[]): Record<string, string[]> {
  return ids.reduce<Record<string, string[]>>((acc, id) => {
    const type = id.split(':')[0] || 'unknown';
    (acc[type] ||= []).push(id);
    return acc;
  }, {});
}

export function formatHarnessDiff(left: DiffTarget, right: DiffTarget, diff: DiffResult): string {
  const lines: string[] = [
    'Harness diff',
    `left:  ${shortHarnessId(left.harnessId)} (session: ${left.sessionId})`,
    `right: ${shortHarnessId(right.harnessId)} (session: ${right.sessionId})`,
    '',
  ];

  if (diff.changed.length === 0 && diff.onlyLeft.length === 0 && diff.onlyRight.length === 0) {
    return `${lines.join('\n')}No differences\n`;
  }

  if (diff.changed.length > 0) {
    lines.push('Changed:');
    const types = [...new Set(diff.changed.map((entry) => entry.id.split(':')[0] || 'unknown'))].sort();
    for (const type of types) {
      lines.push(`  ${type}:`);
      const typed = diff.changed
        .filter((e) => (e.id.split(':')[0] || 'unknown') === type)
        .sort((a, b) => a.id.localeCompare(b.id));
      for (const entry of typed) {
        lines.push(`    ${entry.id}: ${entry.left} → ${entry.right}`);
      }
    }
    lines.push('');
  }

  if (diff.onlyLeft.length > 0) {
    lines.push('Removed:');
    for (const [type, ids] of Object.entries(groupByType(diff.onlyLeft)).sort(([a], [b]) => a.localeCompare(b))) {
      lines.push(`  ${type}:`);
      for (const id of ids.sort()) {
        lines.push(`    ${id} @ ${resourceVersion(left.manifest.resources, id)}`);
      }
    }
    lines.push('');
  }

  if (diff.onlyRight.length > 0) {
    lines.push('Added:');
    for (const [type, ids] of Object.entries(groupByType(diff.onlyRight)).sort(([a], [b]) => a.localeCompare(b))) {
      lines.push(`  ${type}:`);
      for (const id of ids.sort()) {
        lines.push(`    ${id} @ ${resourceVersion(right.manifest.resources, id)}`);
      }
    }
    lines.push('');
  }

  return lines.join('\n');
}

function resourceVersion(resources: ResourceRef[], baseId: string): string {
  return resources.find((ref) => resourceBaseId(ref) === baseId)?.version ?? 'unknown';
}

export function runDiff(first: string, second: string, repoDir: string | undefined, json: boolean): string {
  const left = resolveDiffTarget(first, repoDir);
  const right = resolveDiffTarget(second, repoDir);
  const byHarnessId = left.resolvedByHarnessId || right.resolvedByHarnessId;
  const leftRefs = byHarnessId ? left.manifest.resources.filter(harnessRefParticipates) : left.manifest.resources;
  const rightRefs = byHarnessId ? right.manifest.resources.filter(harnessRefParticipates) : right.manifest.resources;
  const diff = diffHarnessRefs(leftRefs, rightRefs);
  if (json) {
    return JSON.stringify({
      left: { harnessId: left.harnessId, sessionId: left.sessionId, resolvedByHarnessId: left.resolvedByHarnessId },
      right: { harnessId: right.harnessId, sessionId: right.sessionId, resolvedByHarnessId: right.resolvedByHarnessId },
      changed: diff.changed,
      onlyLeft: diff.onlyLeft,
      onlyRight: diff.onlyRight,
    }, null, 2);
  }
  return formatHarnessDiff(left, right, diff);
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);

function listHarnessMatches(pattern: string, repoDir?: string): string {
  if (!looksLikeHarnessId(pattern)) {
    throw new Error(`Harness id must be at least 8 hex characters: ${pattern}`);
  }
  const matches = findManifestsByHarnessId(pattern, repoDir);
  return JSON.stringify(
    matches.map((m) => ({ sessionId: m.sessionId, harnessId: m.harnessId })),
    null,
    2,
  );
}

if (isMain) {
  runTool({
    name: 'registry',
    description: 'Inspect resource registry entries, per-run manifests, and harness ids',
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
        throw new Error('diff requires <session|harness> <session|harness>');
      }
      console.log(runDiff(first, second, repoDir, Boolean(args.json)));
      return;
    }

    if (subcommand === 'harness') {
      if (!first) {
        throw new Error('harness requires <harness-id>');
      }
      console.log(listHarnessMatches(first, repoDir));
      return;
    }

    throw new Error(`Unknown subcommand: ${subcommand || '(none)'}`);
  },
  });
}
