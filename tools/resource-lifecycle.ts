#!/usr/bin/env -S npx tsx
import { runTool } from '../shared/lib/tool-runner.ts';
import { getRegistryConfig } from '../shared/lib/config.ts';
import {
  evaluatePromotion,
  getPointerEntry,
  listTransitionsForResource,
  promote,
  readActivePointers,
  reject,
  rollback,
} from '../shared/lib/resource-lifecycle.ts';
import type { ResourceType } from '../shared/lib/resource-registry.ts';

function requireFlag(value: string | undefined, name: string): string {
  if (!value) {
    throw new Error(`Missing required --${name}`);
  }
  return value;
}

function actor() {
  return {
    kind: 'cli',
    user: process.env.USER || 'unknown',
    sessionId: process.env.WAVEMILL_SESSION,
  };
}

function output(value: unknown, json = false): void {
  if (json) {
    console.log(JSON.stringify(value, null, 2));
    return;
  }
  console.log(JSON.stringify(value, null, 2));
}

runTool({
  name: 'resource-lifecycle',
  description: 'Inspect and manage mutable resource lifecycle state',
  options: {
    type: { type: 'string', description: 'Resource type' },
    name: { type: 'string', description: 'Resource name' },
    version: { type: 'string', description: 'Resource version' },
    to: { type: 'string', description: 'Target lifecycle state' },
    rationale: { type: 'string', description: 'Decision rationale' },
    traffic: { type: 'string', description: 'Canary traffic percent' },
    limit: { type: 'string', description: 'History limit' },
    json: { type: 'boolean', description: 'Print JSON output' },
    force: { type: 'boolean', description: 'Bypass promotion evidence gate' },
    'repo-dir': { type: 'string', description: 'Repository directory override' },
  },
  positional: {
    name: 'verb',
    description: 'Subcommand: list | show | history | evaluate | promote | reject | rollback',
    multiple: true,
  },
  async run({ args, positional }) {
    const [verb] = positional;
    const repoDir = args['repo-dir'] as string | undefined;
    if (getRegistryConfig(repoDir).enabled === false) {
      console.log('registry disabled');
      return;
    }

    const type = args.type as ResourceType | undefined;
    const name = args.name as string | undefined;
    const json = Boolean(args.json);

    if (verb === 'list') {
      const entries = Object.entries(readActivePointers(repoDir).entries)
        .filter(([key]) => (!type || key.startsWith(`${type}:`)) && (!name || key === `${type || key.split(':')[0]}:${name}`))
        .map(([key, value]) => ({ key, ...value }));
      output(entries, json);
      return;
    }

    if (verb === 'show') {
      const resourceType = requireFlag(type, 'type') as ResourceType;
      const resourceName = requireFlag(name, 'name');
      output({
        pointerEntry: getPointerEntry(resourceType, resourceName, repoDir),
        recentTransitions: listTransitionsForResource(resourceType, resourceName, repoDir).slice(-5).reverse(),
      }, json);
      return;
    }

    if (verb === 'history') {
      const resourceType = requireFlag(type, 'type') as ResourceType;
      const resourceName = requireFlag(name, 'name');
      const limit = Number(args.limit || 20);
      output(listTransitionsForResource(resourceType, resourceName, repoDir).slice(-limit).reverse(), json);
      return;
    }

    if (verb === 'evaluate') {
      const resourceType = requireFlag(type, 'type') as ResourceType;
      const resourceName = requireFlag(name, 'name');
      const version = requireFlag(args.version as string | undefined, 'version');
      const toState = requireFlag(args.to as string | undefined, 'to') as 'canary' | 'stable';
      const evaluation = evaluatePromotion({ id: `${resourceType}:${resourceName}@${version}`, type: resourceType, name: resourceName, version }, toState, repoDir);
      output(evaluation, true);
      if (!evaluation.eligible) {
        process.exitCode = 1;
      }
      return;
    }

    if (verb === 'promote') {
      const resourceType = requireFlag(type, 'type') as ResourceType;
      const resourceName = requireFlag(name, 'name');
      const version = requireFlag(args.version as string | undefined, 'version');
      const toState = requireFlag(args.to as string | undefined, 'to') as 'canary' | 'stable';
      const result = await promote({
        id: `${resourceType}:${resourceName}@${version}`,
        type: resourceType,
        name: resourceName,
        version,
      }, {
        toState,
        rationale: requireFlag(args.rationale as string | undefined, 'rationale'),
        trafficPercent: args.traffic ? Number(args.traffic) : undefined,
        force: Boolean(args.force),
        actor: actor(),
      }, repoDir);
      output(result, json);
      return;
    }

    if (verb === 'reject') {
      const resourceType = requireFlag(type, 'type') as ResourceType;
      const resourceName = requireFlag(name, 'name');
      const version = requireFlag(args.version as string | undefined, 'version');
      const result = await reject({
        id: `${resourceType}:${resourceName}@${version}`,
        type: resourceType,
        name: resourceName,
        version,
      }, {
        rationale: requireFlag(args.rationale as string | undefined, 'rationale'),
        actor: actor(),
      }, repoDir);
      output(result, json);
      return;
    }

    if (verb === 'rollback') {
      const resourceType = requireFlag(type, 'type') as ResourceType;
      const resourceName = requireFlag(name, 'name');
      const result = await rollback(resourceType, resourceName, {
        rationale: requireFlag(args.rationale as string | undefined, 'rationale'),
        actor: actor(),
      }, repoDir);
      output(result, json);
      return;
    }

    throw new Error(`Unknown subcommand: ${verb || '(none)'}`);
  },
});
