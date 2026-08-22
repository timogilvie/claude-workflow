import type { ResourceRef } from './resource-registry.ts';
import {
  HARNESS_EXCLUDED_RESOURCE_TYPES,
  computeHarnessId,
  findManifestsByHarnessId,
  getManifest,
  listManifests,
  type ManifestListEntry,
  type ResourceManifest,
} from './resource-manifest.ts';

interface ParsedRef {
  key: string;
  type: string;
  name: string;
  version: string;
  tuple: string;
}

export interface ResolvedHarnessSelector {
  selector: string;
  harnessId: string;
  sessions: string[];
  manifest: ResourceManifest;
  resources: ResourceRef[];
}

export interface HarnessDiffChange {
  name: string;
  from: string;
  to: string;
}

export interface HarnessDiffResult {
  added: string[];
  removed: string[];
  changed: HarnessDiffChange[];
  unchanged: string[];
  onlyLeft: string[];
  onlyRight: string[];
  excludedLeft: string[];
  excludedRight: string[];
}

const EXCLUDED_TYPES = new Set<string>(HARNESS_EXCLUDED_RESOURCE_TYPES);

function tupleForRef(ref: ResourceRef): string {
  return ref.id.endsWith(`@${ref.version}`) ? ref.id : `${ref.id}@${ref.version}`;
}

function parseRef(ref: ResourceRef): ParsedRef {
  const tuple = tupleForRef(ref);
  const colon = ref.id.indexOf(':');
  const type = colon >= 0 ? ref.id.slice(0, colon) : '';
  const idBody = colon >= 0 ? ref.id.slice(colon + 1) : ref.id;
  const atVersion = idBody.endsWith(`@${ref.version}`) ? idBody.slice(0, -(`@${ref.version}`).length) : idBody;
  return {
    key: `${type}:${atVersion}`,
    type,
    name: atVersion,
    version: ref.version,
    tuple,
  };
}

function sortedUnique(values: string[]): string[] {
  return [...new Set(values)].sort();
}

function harnessMatches(harnessId: string, repoDir?: string): ManifestListEntry[] {
  const matches = findManifestsByHarnessId(harnessId, repoDir);
  if (harnessId.length < 64 && matches.length > 1) {
    const candidates = matches.map((entry) => `${entry.sessionId}:${entry.harnessId}`).join(', ');
    throw new Error(`Ambiguous harness ID prefix: ${harnessId} (${candidates})`);
  }
  return matches;
}

export function resolveHarnessSelector(selector: string, repoDir?: string): ResolvedHarnessSelector {
  const sessionManifest = getManifest(selector, repoDir);
  if (sessionManifest) {
    const harnessId = sessionManifest.harnessId ?? computeHarnessId(sessionManifest.resources || []);
    const sessions = listManifests(repoDir)
      .filter((entry) => entry.harnessId === harnessId)
      .map((entry) => entry.sessionId)
      .sort();
    return {
      selector,
      harnessId,
      sessions: sessions.length > 0 ? sessions : [sessionManifest.sessionId],
      manifest: sessionManifest,
      resources: sessionManifest.resources || [],
    };
  }

  const matches = harnessMatches(selector, repoDir);
  if (matches.length === 0) {
    throw new Error(`Harness ID or session not found: ${selector}`);
  }
  const representative = matches[0];
  return {
    selector,
    harnessId: representative.harnessId,
    sessions: matches.map((entry) => entry.sessionId).sort(),
    manifest: representative.manifest,
    resources: representative.manifest.resources || [],
  };
}

export function diffHarnesses(leftRefs: ResourceRef[], rightRefs: ResourceRef[]): HarnessDiffResult {
  const leftParsed = leftRefs.map(parseRef);
  const rightParsed = rightRefs.map(parseRef);
  const leftIncluded = leftParsed.filter((ref) => !EXCLUDED_TYPES.has(ref.type));
  const rightIncluded = rightParsed.filter((ref) => !EXCLUDED_TYPES.has(ref.type));
  const leftByKey = new Map(leftIncluded.map((ref) => [ref.key, ref]));
  const rightByKey = new Map(rightIncluded.map((ref) => [ref.key, ref]));
  const keys = sortedUnique([...leftByKey.keys(), ...rightByKey.keys()]);

  const added: string[] = [];
  const removed: string[] = [];
  const changed: HarnessDiffChange[] = [];
  const unchanged: string[] = [];

  for (const key of keys) {
    const left = leftByKey.get(key);
    const right = rightByKey.get(key);
    if (left && right) {
      if (left.version === right.version) {
        unchanged.push(left.tuple);
      } else {
        changed.push({ name: key, from: left.version, to: right.version });
      }
    } else if (right) {
      added.push(right.tuple);
    } else if (left) {
      removed.push(left.tuple);
    }
  }

  const leftTuples = sortedUnique(leftIncluded.map((ref) => ref.tuple));
  const rightTuples = sortedUnique(rightIncluded.map((ref) => ref.tuple));
  const leftSet = new Set(leftTuples);
  const rightSet = new Set(rightTuples);

  return {
    added,
    removed,
    changed,
    unchanged,
    onlyLeft: leftTuples.filter((entry) => !rightSet.has(entry)),
    onlyRight: rightTuples.filter((entry) => !leftSet.has(entry)),
    excludedLeft: sortedUnique(leftParsed.filter((ref) => EXCLUDED_TYPES.has(ref.type)).map((ref) => ref.tuple)),
    excludedRight: sortedUnique(rightParsed.filter((ref) => EXCLUDED_TYPES.has(ref.type)).map((ref) => ref.tuple)),
  };
}

function groupByType(entries: string[]): Map<string, string[]> {
  const grouped = new Map<string, string[]>();
  for (const entry of entries) {
    const type = entry.split(':', 1)[0] || 'unknown';
    grouped.set(type, [...(grouped.get(type) || []), entry]);
  }
  return new Map([...grouped.entries()].sort(([a], [b]) => a.localeCompare(b)));
}

function appendGrouped(lines: string[], title: string, prefix: string, entries: string[]): void {
  if (entries.length === 0) {
    return;
  }
  lines.push('', title);
  for (const [type, groupedEntries] of groupByType(entries)) {
    lines.push(`${type}:`);
    for (const entry of groupedEntries.sort()) {
      lines.push(`${prefix} ${entry}`);
    }
  }
}

export function formatHarnessDiff(
  left: ResolvedHarnessSelector,
  right: ResolvedHarnessSelector,
  diff: HarnessDiffResult,
): string {
  const lines = [
    `Left:  ${left.harnessId} (${left.sessions.join(', ') || 'no sessions'})`,
    `Right: ${right.harnessId} (${right.sessions.join(', ') || 'no sessions'})`,
  ];

  if (diff.added.length === 0 && diff.removed.length === 0 && diff.changed.length === 0) {
    lines.push('', 'No differences');
  } else {
    appendGrouped(lines, 'Removed', '-', diff.removed);
    appendGrouped(lines, 'Added', '+', diff.added);
    if (diff.changed.length > 0) {
      lines.push('', 'Changed');
      for (const change of [...diff.changed].sort((a, b) => a.name.localeCompare(b.name))) {
        const type = change.name.split(':', 1)[0] || 'unknown';
        lines.push(`${type}:`);
        lines.push(`~ ${change.name} ${change.from} -> ${change.to}`);
      }
    }
  }

  const excluded = sortedUnique([...diff.excludedLeft, ...diff.excludedRight]);
  appendGrouped(lines, 'Environment/tool (not part of harnessId)', ' ', excluded);
  return lines.join('\n');
}

export function formatHarnessResources(resolved: ResolvedHarnessSelector): string {
  const included = resolved.resources
    .map(parseRef)
    .filter((ref) => !EXCLUDED_TYPES.has(ref.type))
    .map((ref) => ref.tuple);
  const excluded = resolved.resources
    .map(parseRef)
    .filter((ref) => EXCLUDED_TYPES.has(ref.type))
    .map((ref) => ref.tuple);
  const lines = [
    `Harness: ${resolved.harnessId}`,
    `Sessions: ${resolved.sessions.join(', ') || 'none'}`,
  ];
  appendGrouped(lines, 'Resources', ' ', sortedUnique(included));
  appendGrouped(lines, 'Environment/tool (not part of harnessId)', ' ', sortedUnique(excluded));
  return lines.join('\n');
}
