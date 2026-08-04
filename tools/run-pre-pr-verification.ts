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
import { execSync } from 'node:child_process';
import { getPrePrVerificationConfig, getIntegrationConfig } from '../shared/lib/config.ts';
import {
  runVerificationRecipe,
  writeVerificationArtifact,
  readAndValidateArtifact,
  fetchAndResolveBase,
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
  baseRef?: string;
  override?: string;
}

function parseCLI(): CLIOptions {
  const args = process.argv.slice(2);
  let stateDir = process.cwd();
  let force = false;
  let dryRun = false;
  let json = false;
  let baseRef: string | undefined;
  let override: string | undefined;

  // Env-var override (per task packet): WAVEMILL_PRE_PR_OVERRIDE=1 activates
  // the override; WAVEMILL_PRE_PR_OVERRIDE_REASON supplies the reason. The
  // CLI --override flag remains for direct operator use.
  if (process.env.WAVEMILL_PRE_PR_OVERRIDE === '1') {
    override = process.env.WAVEMILL_PRE_PR_OVERRIDE_REASON ?? '';
  }

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--force') {
      force = true;
    } else if (arg === '--help' || arg === '-h') {
      console.log(
        [
          'Usage: npx tsx tools/run-pre-pr-verification.ts [state-dir] [options]',
          '',
          'Options:',
          '  --force              Ignore an existing artifact and rerun the recipe',
          '  --dry-run            Print the recipe without executing commands',
          '  --json               Emit machine-readable output',
          '  --base-ref <branch>   Override the configured base branch',
          '  --override <reason>   Record an operator override with the artifact',
          '  --help               Show this help',
          '',
          'The command automatically fetches the base branch before verification.',
        ].join('\n'),
      );
      process.exit(0);
    } else if (arg === '--dry-run') {
      dryRun = true;
    } else if (arg === '--json') {
      json = true;
    } else if (arg.startsWith('--base-ref=')) {
      baseRef = arg.slice('--base-ref='.length);
    } else if (arg === '--base-ref') {
      if (i + 1 >= args.length) {
        console.error('✗ --base-ref requires a branch name.');
        process.exit(1);
      }
      baseRef = args[i + 1];
      i += 1;
    } else if (arg.startsWith('--override=')) {
      override = arg.slice('--override='.length);
    } else if (arg === '--override') {
      if (i + 1 < args.length) {
        override = args[i + 1];
        i += 1; // consume the reason arg so it is not re-parsed as positional
      } else {
        override = '';
      }
    } else if (!arg.startsWith('--')) {
      // Positional argument = state-dir
      stateDir = resolve(arg);
    }
  }

  return { stateDir, force, dryRun, json, baseRef, override };
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

  // Dry-run: show commands without executing (before git state resolution)
  if (opts.dryRun) {
    if (!opts.json) {
      console.log('📋 Verification recipe (dry-run):');
      config.recipe?.commands?.forEach((cmd, i) => {
        console.log(`  ${i + 1}. ${cmd}`);
      });
      console.log(
        `\nTimeout: ${config.recipe?.timeoutSeconds ?? 300}s per command`,
      );
      console.log('Base branch will be fetched before required commands run.');
    } else {
      console.log(
        JSON.stringify({
          commands: config.recipe?.commands,
          timeout: config.recipe?.timeoutSeconds ?? 300,
          fetchesBaseBeforeRun: true,
        }),
      );
    }
    process.exit(0);
  }

  // Resolve the controller's configured base branch (not hard-coded main).
  const integration = getIntegrationConfig(opts.stateDir);
  const baseBranch =
    opts.baseRef ||
    process.env.WAVEMILL_BASE_BRANCH ||
    integration.integrationBranch ||
    'auto/integration';

  // Get current git state. Fail fast if unavailable — the artifact's
  // whole purpose is SHA-anchored freshness.
  let headSha: string;
  let baseSha: string;
  let workingBranch: string;
  try {
    headSha = execSync('git rev-parse HEAD', { cwd: opts.stateDir, encoding: 'utf-8' }).trim();
    workingBranch = execSync('git rev-parse --abbrev-ref HEAD', {
      cwd: opts.stateDir,
      encoding: 'utf-8',
    }).trim();
  } catch (err) {
    const msg = (err as Error).message;
    if (!opts.json) {
      console.error(`✗ Unable to resolve git state against base '${baseBranch}': ${msg}`);
    } else {
      console.log(JSON.stringify({ error: 'git_state_unavailable', baseBranch, message: msg }));
    }
    process.exit(1);
  }

  if (!opts.json) {
    console.log(`🔄 Fetching base branch '${baseBranch}'...`);
  }
  const baseResolution = fetchAndResolveBase(opts.stateDir, baseBranch);
  if ('kind' in baseResolution) {
    if (!opts.json) {
      console.error(`✗ ${baseResolution.diagnostics}`);
    } else {
      console.log(
        JSON.stringify({
          error: baseResolution.kind,
          baseBranch,
          message: baseResolution.message,
          diagnostics: baseResolution.diagnostics,
        }),
      );
    }
    process.exit(1);
  }
  baseSha = baseResolution.baseSha;
  if (!opts.json) {
    console.log(`✓ Base refreshed to ${baseSha}`);
  }

  // Check if artifact is fresh AND matches current HEAD/base (skip if --force).
  if (!opts.force) {
    const artifactPath = join(opts.stateDir, '.wavemill/pre-pr-verification/artifact.json');
    const { artifact, isValid, shasMismatch } = readAndValidateArtifact(
      artifactPath,
      headSha,
      baseSha,
    );

    if (artifact && isValid && !shasMismatch) {
      const staleTtl = (config.staleTtlSeconds ?? 3600) * 1000;
      const age = Date.now() - new Date(artifact.timestamp).getTime();

      if (age < staleTtl && artifact.overallStatus === 'pass') {
        if (!opts.json) {
          console.log('✓ Verification artifact is fresh, SHA-matched, and passing.');
        } else {
          console.log(
            JSON.stringify({
              status: 'pass',
              fresh: true,
              headSha,
              baseSha,
              baseRefresh: baseResolution,
            }),
          );
        }
        process.exit(0);
      }
    }
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
    console.log(
      JSON.stringify({
        status: result.status,
        commands: result.commands,
        headSha,
        baseSha,
        baseRefresh: baseResolution,
      }),
    );
  }

  // Write artifact. Operator override requires a non-empty reason and a
  // resolvable operator identity (env WAVEMILL_PRE_PR_OVERRIDE_OPERATOR
  // takes precedence over $USER for controller-driven overrides).
  const artifactPath = join(opts.stateDir, '.wavemill/pre-pr-verification/artifact.json');
  let overriddenBy: OperatorOverride | undefined;
  if (opts.override !== undefined) {
    const reason = opts.override.trim();
    if (!reason) {
      if (!opts.json) {
        console.error('✗ --override requires a non-empty reason.');
      } else {
        console.log(JSON.stringify({ error: 'override_reason_required' }));
      }
      process.exit(1);
    }
    const operator =
      process.env.WAVEMILL_PRE_PR_OVERRIDE_OPERATOR || process.env.USER;
    if (!operator) {
      if (!opts.json) {
        console.error(
          '✗ Unable to resolve override operator. Set WAVEMILL_PRE_PR_OVERRIDE_OPERATOR or USER.',
        );
      } else {
        console.log(JSON.stringify({ error: 'override_operator_unresolved' }));
      }
      process.exit(1);
    }
    overriddenBy = {
      reason,
      timestamp: new Date().toISOString(),
      operator,
    };
  }

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
