#!/usr/bin/env -S npx tsx
import { writeFile } from 'node:fs/promises';

import {
  describeSeamArtifactContract,
  getSeamArtifactPath,
  getSeamArtifactSpec,
  listSeamArtifacts,
  readSeamArtifact,
  validateSeamArtifactContent,
  type SeamArtifactName,
  type SeamStageName,
} from '../shared/lib/seam-artifacts.ts';

const USAGE = `seam-artifact-cli — validate shared seam artifacts

Subcommands:
  validate <artifact> <path> [--canonicalize] [--coerce-unverified-claim]
  validate <artifact> --feature-dir <dir> [--stage <stage>] [--canonicalize] [--coerce-unverified-claim]
  describe <artifact>
  list [--json]
`;

interface ParsedFlags {
  canonicalize: boolean;
  coerceUnverifiedClaim: boolean;
  featureDir?: string;
  stage?: SeamStageName;
  json: boolean;
  positional: string[];
}

async function main(): Promise<void> {
  const [subcommand, ...rest] = process.argv.slice(2);
  if (!subcommand || subcommand === '--help' || subcommand === '-h') {
    console.log(USAGE);
    process.exit(0);
  }

  if (subcommand === 'list') {
    const flags = parseFlags(rest);
    if (flags.json) {
      console.log(JSON.stringify(listSeamArtifacts().map(({ describe: _describe, semanticRules: _rules, ...spec }) => spec)));
    } else {
      for (const spec of listSeamArtifacts()) {
        console.log(`${spec.name}\t${spec.filename}\t${spec.kind}\t${spec.writer}\t${spec.phase}`);
      }
    }
    return;
  }

  if (subcommand === 'describe') {
    const [artifact] = rest;
    assertArtifactName(artifact);
    console.log(describeSeamArtifactContract(artifact));
    return;
  }

  if (subcommand === 'validate') {
    await validateCommand(rest);
    return;
  }

  console.error(`unknown subcommand: ${subcommand}`);
  process.exit(2);
}

async function validateCommand(args: string[]): Promise<void> {
  const [artifact, ...flagArgs] = args;
  assertArtifactName(artifact);
  const flags = parseFlags(flagArgs);

  let result;
  let artifactPath: string;
  if (flags.featureDir) {
    artifactPath = getSeamArtifactPath(artifact, flags.featureDir, flags.stage);
    result = await readSeamArtifact(artifact, flags.featureDir, {
      stage: flags.stage,
      canonicalize: flags.canonicalize,
      coerceUnverifiedClaim: flags.coerceUnverifiedClaim,
    });
  } else {
    artifactPath = flags.positional[0] ?? '';
    if (!artifactPath) {
      console.error('validate requires <path> or --feature-dir <dir>');
      process.exit(2);
    }
    const raw = await import('node:fs/promises').then((fs) => fs.readFile(artifactPath, 'utf-8'));
    result = validateSeamArtifactContent(artifact, raw, {
      coerceUnverifiedClaim: flags.coerceUnverifiedClaim,
    });
    if (result.ok && flags.canonicalize && result.changed) {
      await writeFile(artifactPath, result.canonicalContent, 'utf-8');
    }
  }

  const payload = result.ok
    ? {
      ok: true,
      artifact,
      path: artifactPath,
      warnings: result.warnings,
      changed: result.changed,
      value: result.value,
    }
    : {
      ok: false,
      artifact,
      path: artifactPath,
      errors: result.errors,
    };
  console.log(JSON.stringify(payload));
  process.exit(result.ok ? 0 : 1);
}

function parseFlags(args: string[]): ParsedFlags {
  const flags: ParsedFlags = {
    canonicalize: false,
    coerceUnverifiedClaim: false,
    json: false,
    positional: [],
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--canonicalize') {
      flags.canonicalize = true;
    } else if (arg === '--coerce-unverified-claim') {
      flags.coerceUnverifiedClaim = true;
    } else if (arg === '--json') {
      flags.json = true;
    } else if (arg === '--feature-dir') {
      flags.featureDir = requiredValue(args, ++index, arg);
    } else if (arg === '--stage') {
      const value = requiredValue(args, ++index, arg);
      if (!['planning', 'coding', 'review', 'ready'].includes(value)) {
        throw new UsageError(`invalid --stage value: ${value}`);
      }
      flags.stage = value as SeamStageName;
    } else if (arg.startsWith('--')) {
      throw new UsageError(`unknown option: ${arg}`);
    } else {
      flags.positional.push(arg);
    }
  }
  return flags;
}

function requiredValue(args: string[], index: number, flag: string): string {
  const value = args[index];
  if (!value || value.startsWith('--')) {
    throw new UsageError(`${flag} requires a value`);
  }
  return value;
}

function assertArtifactName(value: string | undefined): asserts value is SeamArtifactName {
  if (!value) throw new UsageError('artifact is required');
  try {
    getSeamArtifactSpec(value as SeamArtifactName);
  } catch {
    throw new UsageError(`unknown artifact: ${value}`);
  }
}

class UsageError extends Error {}

main().catch((error) => {
  if (error instanceof UsageError) {
    console.error(error.message);
    process.exit(2);
  }
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(2);
});
