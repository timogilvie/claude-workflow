#!/usr/bin/env node

import { resolve as resolvePath } from 'node:path';
import { parseModelSelector, type ModelSelector } from '../shared/lib/model-registry.ts';
import { resolveEffectiveModel } from '../shared/lib/model-resolution.ts';
import { readQuotaSnapshot } from '../shared/lib/quota-state.ts';

type RoutingRole = 'planner' | 'coder' | 'reviewer';

function parseArgs(argv: string[]) {
  const parsed: Record<string, string> = {};
  for (let i = 2; i < argv.length; i += 1) {
    const key = argv[i];
    if (!key.startsWith('--')) {
      continue;
    }
    const value = argv[i + 1];
    if (!value || value.startsWith('--')) {
      throw new Error(`Missing value for ${key}`);
    }
    parsed[key.slice(2)] = value;
    i += 1;
  }
  return parsed;
}

function parseRole(raw: string): RoutingRole {
  if (raw === 'planner' || raw === 'coder' || raw === 'reviewer') {
    return raw;
  }
  throw new Error(`Invalid --role: ${raw}`);
}

function parseRequestedSelector(raw: string): ModelSelector {
  if (!raw.trim()) {
    throw new Error('Empty --selector value');
  }
  const parsed = parseModelSelector(raw);
  if (parsed.ok) {
    return parsed.selector;
  }
  return { kind: 'pinned', modelId: raw };
}

function roleToTaskType(role: RoutingRole): 'planning' | 'coding' | 'review' {
  if (role === 'planner') return 'planning';
  if (role === 'coder') return 'coding';
  return 'review';
}

function main() {
  const args = parseArgs(process.argv);
  const role = parseRole(args.role ?? '');
  const selector = parseRequestedSelector(args.selector ?? '');
  const repoDir = resolvePath(args['repo-dir'] ?? process.cwd());
  const resolved = resolveEffectiveModel({
    workspaceSelector: args['workspace-selector'] || undefined,
    userOverride: selector,
    policyContext: {
      taskType: roleToTaskType(role),
      difficulty: 'medium',
      quotaState: readQuotaSnapshot(repoDir),
      repoDir,
    },
  });

  const payload: Record<string, unknown> = {
    role,
    requestedSelector: resolved.requested,
    resolvedModelId: resolved.resolved,
    sourceLayer: resolved.resolutionLayer,
    resolutionSource: resolved.source,
    timestamp: new Date().toISOString(),
  };
  if (resolved.fallbackReason) {
    payload.fallbackReason = resolved.fallbackReason;
  }
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

try {
  main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exit(1);
}
