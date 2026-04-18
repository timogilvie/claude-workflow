#!/usr/bin/env -S npx tsx
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  estimateQuotaHealth,
  readQuotaSnapshot,
  type QuotaStatus,
} from '../shared/lib/quota-state.ts';
import { runTool } from '../shared/lib/tool-runner.ts';
import { resolveFromMainRepo } from '../shared/lib/git-utils.ts';
import { getEffectiveRegistry } from '../shared/lib/model-registry.ts';

interface MutableConfig {
  quota?: {
    manualOverrides?: Record<string, {
      status: QuotaStatus;
      reason?: string;
      expiresAt?: string;
    }>;
    thresholds?: {
      volumeThresholdPercent?: number;
      budgetThresholdPercent?: number;
      nearLimitCount?: number;
    };
  };
  [key: string]: unknown;
}

function resolveConfigPath(repoDir?: string): string {
  return resolveFromMainRepo('.wavemill-config.json', repoDir);
}

function readConfig(repoDir?: string): MutableConfig {
  const configPath = resolveConfigPath(repoDir);
  if (!existsSync(configPath)) {
    return {};
  }

  const raw = readFileSync(configPath, 'utf-8');
  const parsed = JSON.parse(raw) as MutableConfig;
  if (!parsed || typeof parsed !== 'object') {
    return {};
  }
  return parsed;
}

function writeConfig(config: MutableConfig, repoDir?: string): string {
  const configPath = resolveConfigPath(repoDir);
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf-8');
  return configPath;
}

function resolveModelId(modelInput: string, repoDir?: string): string {
  const requested = modelInput.trim();
  if (!requested) {
    return requested;
  }

  const normalized = requested.toLowerCase();
  const aliases: Record<string, string> = {
    sonnet: 'claude-sonnet-4-6',
    opus: 'claude-opus-4-7',
    haiku: 'claude-haiku-4-5-20251001',
  };
  if (aliases[normalized]) {
    return aliases[normalized];
  }

  const registry = getEffectiveRegistry(repoDir);
  if (registry.models[requested]) {
    return requested;
  }

  const partialMatches = Object.keys(registry.models)
    .filter((modelId) => modelId.toLowerCase().includes(normalized));
  if (partialMatches.length === 1) {
    return partialMatches[0];
  }

  return requested;
}

function asStatus(value: string | undefined): QuotaStatus {
  if (value === 'healthy' || value === 'degrading' || value === 'exhausted') {
    return value;
  }
  throw new Error(`Invalid status '${value ?? ''}'. Expected healthy|degrading|exhausted.`);
}

runTool({
  name: 'quota-control',
  description: 'Manage quota state and manual overrides',
  options: {
    reason: { type: 'string', description: 'Reason string for manual override' },
    expires: { type: 'string', description: 'Override expiration timestamp (ISO-8601)' },
    'repo-dir': { type: 'string', description: 'Repository directory (default: cwd)' },
    json: { type: 'boolean', description: 'Output machine-readable JSON for status/estimate' },
  },
  positional: {
    name: 'subcommand args',
    description: 'Subcommand (status|set|clear|estimate) and optional arguments',
    multiple: true,
    required: true,
  },
  examples: [
    'npx tsx tools/quota-control.ts status',
    'npx tsx tools/quota-control.ts set sonnet degrading --reason "known peak window"',
    'npx tsx tools/quota-control.ts clear sonnet',
    'npx tsx tools/quota-control.ts estimate claude-sonnet-4-6',
  ],
  additionalHelp: `Subcommands:
  status                   Show current snapshot and active manual overrides
  set <model> <status>     Set manual override for a model
  clear <model>            Remove manual override for a model
  estimate <model>         Show proactive health estimate`,
  async run({ args, positional }) {
    const repoDir = args['repo-dir'] as string | undefined;
    const subcommand = positional[0];

    if (subcommand === 'status') {
      const snapshot = readQuotaSnapshot(repoDir);
      const config = readConfig(repoDir);
      const overrides = config.quota?.manualOverrides ?? {};
      const payload = {
        snapshotAt: snapshot.snapshotAt,
        models: snapshot.models,
        manualOverrides: overrides,
      };
      if (args.json) {
        console.log(JSON.stringify(payload, null, 2));
      } else {
        console.log(`Snapshot: ${snapshot.snapshotAt}`);
        const modelIds = Object.keys(snapshot.models).sort();
        if (modelIds.length === 0) {
          console.log('No tracked models.');
        } else {
          for (const modelId of modelIds) {
            const model = snapshot.models[modelId];
            const reason = model.lastReason ? ` (${model.lastReason})` : '';
            console.log(`${modelId}: ${model.status}${reason}`);
          }
        }

        const overrideIds = Object.keys(overrides).sort();
        if (overrideIds.length > 0) {
          console.log('Manual overrides:');
          for (const modelId of overrideIds) {
            const override = overrides[modelId];
            const details = [
              override.status,
              override.reason ? `reason=${override.reason}` : '',
              override.expiresAt ? `expires=${override.expiresAt}` : '',
            ].filter(Boolean).join(', ');
            console.log(`- ${modelId}: ${details}`);
          }
        }
      }
      return;
    }

    if (subcommand === 'set') {
      const modelInput = positional[1];
      const nextStatus = asStatus(positional[2]);
      if (!modelInput) {
        throw new Error('Usage: quota-control set <model-id> <status> [--reason text] [--expires iso]');
      }

      if (args.expires) {
        const expiresAtMs = Date.parse(String(args.expires));
        if (Number.isNaN(expiresAtMs)) {
          throw new Error(`Invalid --expires value '${String(args.expires)}'; expected ISO-8601 timestamp.`);
        }
      }

      const modelId = resolveModelId(modelInput, repoDir);
      const config = readConfig(repoDir);
      config.quota = config.quota ?? {};
      config.quota.manualOverrides = config.quota.manualOverrides ?? {};
      config.quota.manualOverrides[modelId] = {
        status: nextStatus,
        reason: args.reason ? String(args.reason) : undefined,
        expiresAt: args.expires ? new Date(String(args.expires)).toISOString() : undefined,
      };

      const configPath = writeConfig(config, repoDir);
      console.log(`Override set: ${modelId} -> ${nextStatus}`);
      if (!args.expires) {
        console.warn('Warning: override has no expiration and will stay active until cleared.');
      }
      console.log(`Updated: ${resolve(configPath)}`);
      return;
    }

    if (subcommand === 'clear') {
      const modelInput = positional[1];
      if (!modelInput) {
        throw new Error('Usage: quota-control clear <model-id>');
      }
      const modelId = resolveModelId(modelInput, repoDir);
      const config = readConfig(repoDir);
      const before = config.quota?.manualOverrides?.[modelId];
      if (!config.quota?.manualOverrides || !before) {
        console.log(`No override found for ${modelId}.`);
        return;
      }

      delete config.quota.manualOverrides[modelId];
      if (Object.keys(config.quota.manualOverrides).length === 0) {
        delete config.quota.manualOverrides;
      }
      if (config.quota && Object.keys(config.quota).length === 0) {
        delete config.quota;
      }

      const configPath = writeConfig(config, repoDir);
      console.log(`Override cleared: ${modelId}`);
      console.log(`Updated: ${resolve(configPath)}`);
      return;
    }

    if (subcommand === 'estimate') {
      const modelInput = positional[1];
      if (!modelInput) {
        throw new Error('Usage: quota-control estimate <model-id>');
      }
      const modelId = resolveModelId(modelInput, repoDir);
      const estimate = estimateQuotaHealth(modelId, repoDir);
      if (args.json) {
        console.log(JSON.stringify({ modelId, estimate }, null, 2));
      } else {
        console.log(`${modelId}: ${estimate}`);
      }
      return;
    }

    throw new Error(`Unknown subcommand: ${subcommand || '(none)'}`);
  },
});
