#!/usr/bin/env npx tsx

/**
 * CLI tool to run pre-PR verification locally.
 *
 * Usage:
 *   npx tsx tools/run-pre-pr-verification.ts [state-dir]
 *   npx tsx tools/run-pre-pr-verification.ts features/hok-2603 --force
 *   npx tsx tools/run-pre-pr-verification.ts --dry-run
 *   npx tsx tools/run-pre-pr-verification.ts --override "manual check"
 *
 * The controller calls this to execute the configured verification recipe
 * before PR creation, blocking the PR if commands fail.
 */

import { resolve, join } from 'node:path';
import { existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { getPrePrVerificationConfig } from '../shared/lib/config.ts';
import {
  runVerificationRecipe,
  writeVerificationArtifact,
  readAndValidateArtifact,
} from '../shared/lib/pre-pr-verification.ts';
import type { OperatorOverride } from '../shared/lib/pre-pr-verification-types.ts';

// ────────────────────────────────────────────────────────────────
// CLI Arguments
// ────────────────────────────────────────────────────────────────

interface CLIOptions {
  stateDir: string;
  force: boolean;
  dryRun: boolean;
  json: boolean;
  override?: string;
}

function parseCLI(): CLIOptions {
  const args = process.argv.slice(2);
  let stateDir = process.cwd();
  let force = false;
  let dryRun = false;
  let json = false;
  let override: string | undefined;

  for (const arg of args) {
    if (arg === '--force') {
      force = true;
    } else if (arg === '--dry-run') {
      dryRun = true;
    } else if (arg === '--json') {
      json = true;
    } else if (arg.startsWith('--override=')) {
      override = arg.slice('--override='.length);
    } else if (arg.startsWith('--override')) {
      const idx = args.indexOf(arg);
      if (idx < args.length - 1) {
        override = args[idx + 1];
      }
    } else if (!arg.startsWith('--')) {
      // Positional argument = state-dir
      stateDir = resolve(arg);
    }
  }

  return { stateDir, force, dryRun, json, override };
}

// ────────────────────────────────────────────────────────────────
// Main
// ────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const opts = parseCLI();

  // Load config
  const config = getPrePrVerificationConfig(opts.stateDir);

  if (!config.enabled) {
    if (!opts.json) {
      console.log('ℹ️  Pre-PR verification is disabled in this repository.');
    }
    process.exit(0);
  }

  if (!config.recipe || !config.recipe.commands || config.recipe.commands.length === 0) {
    if (!opts.json) {
      console.error('✗ No verification recipe configured.');
    } else {
      console.log(JSON.stringify({ error: 'no_recipe_configured' }));
    }
    process.exit(1);
  }

  // Check if artifact is fresh (skip if --force)
  if (!opts.force && !opts.dryRun) {
    const artifactPath = join(opts.stateDir, '.wavemill/pre-pr-verification/artifact.json');
    const { artifact } = readAndValidateArtifact(artifactPath);

    if (artifact) {
      const staleTtl = (config.staleTtlSeconds ?? 3600) * 1000;
      const age = Date.now() - new Date(artifact.timestamp).getTime();

      if (age < staleTtl && artifact.overallStatus === 'pass') {
        if (!opts.json) {
          console.log('✓ Verification artifact is fresh and valid.');
        } else {
          console.log(JSON.stringify({ status: 'pass', fresh: true }));
        }
        process.exit(0);
      }
    }
  }

  // Dry-run: show commands without executing
  if (opts.dryRun) {
    if (!opts.json) {
      console.log('📋 Verification recipe (dry-run):');
      config.recipe?.commands?.forEach((cmd, i) => {
        console.log(`  ${i + 1}. ${cmd}`);
      });
      console.log(
        `\nTimeout: ${config.recipe?.timeoutSeconds ?? 300}s per command`,
      );
    } else {
      console.log(
        JSON.stringify({
          commands: config.recipe?.commands,
          timeout: config.recipe?.timeoutSeconds ?? 300,
        }),
      );
    }
    process.exit(0);
  }

  // Get current git state
  let headSha: string | undefined;
  let baseSha: string | undefined;
  let workingBranch: string | undefined;

  try {
    headSha = execSync('git rev-parse HEAD', { cwd: opts.stateDir, encoding: 'utf-8' }).trim();
    baseSha = execSync('git merge-base HEAD origin/main', {
      cwd: opts.stateDir,
      encoding: 'utf-8',
    }).trim();
    workingBranch = execSync('git rev-parse --abbrev-ref HEAD', {
      cwd: opts.stateDir,
      encoding: 'utf-8',
    }).trim();
  } catch {
    // Git state unavailable — continue anyway
  }

  // Run recipe
  if (!opts.json) {
    console.log('🔍 Running pre-PR verification...\n');
  }

  const result = runVerificationRecipe(config.recipe, {
    cwd: opts.stateDir,
    logDir: join(opts.stateDir, '.wavemill/pre-pr-verification'),
    headSha,
    baseSha,
  });

  // Report results
  if (!opts.json) {
    result.commands.forEach((cmd) => {
      const icon = cmd.status === 'pass' ? '✓' : '✗';
      const duration = cmd.durationMs ? ` (${(cmd.durationMs / 1000).toFixed(1)}s)` : '';
      console.log(`${icon} Command ${cmd.index + 1}${duration}: ${cmd.command}`);

      if (cmd.status !== 'pass') {
        console.log(`  Status: ${cmd.status}`);
        if (cmd.failureReason) {
          console.log(`  Reason: ${cmd.failureReason}`);
        }
        if (cmd.logPath) {
          console.log(`  Logs: ${cmd.logPath}`);
        }
      }
    });

    console.log(`\n${result.commands.length} commands run`);
    const passed = result.commands.filter((c) => c.status === 'pass').length;
    console.log(
      `Result: ${passed}/${result.commands.length} passed - ${result.status.toUpperCase()}`,
    );
  } else {
    console.log(JSON.stringify({ status: result.status, commands: result.commands }));
  }

  // Write artifact
  const artifactPath = join(opts.stateDir, '.wavemill/pre-pr-verification/artifact.json');
  const operator = opts.override ? process.env.USER || 'unknown' : undefined;
  const overriddenBy: OperatorOverride | undefined = opts.override
    ? {
        reason: opts.override,
        timestamp: new Date().toISOString(),
        operator,
      }
    : undefined;

  writeVerificationArtifact(result, artifactPath, {
    workingBranch,
    headSha,
    baseSha,
    overriddenBy,
  });

  // Exit with appropriate code
  process.exit(result.status === 'pass' ? 0 : 1);
}

main().catch((err) => {
  console.error(`Error: ${(err as Error).message}`);
  process.exit(1);
});
