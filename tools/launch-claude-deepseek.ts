#!/usr/bin/env -S npx tsx
/**
 * launch-claude-deepseek — Thin CLI wrapper for claude-deepseek agent launches.
 *
 * Resolves DeepSeek credentials and state directory, prints shell-safe KEY=value
 * lines to stdout, and writes the state discovery file. Exits with:
 *   0  success
 *   2  missing API key / secret source
 *   1  validation or unexpected error
 *
 * SECURITY: Never print the API key to stderr. It appears on stdout only so that
 * the parent shell can eval the env block. Callers must not persist stdout to
 * disk or log files.
 */

import { resolve } from 'node:path';
import {
  buildDeepSeekLauncherEnv,
  createDeepSeekStateDir,
  writeDeepSeekStateDiscoveryFile,
  MissingDeepSeekApiKeyError,
  InvalidPathSegmentError,
  UnsafeStateDirError,
} from '../shared/lib/deepseek-launcher.ts';

// ────────────────────────────────────────────────────────────────
// Argument parsing
// ────────────────────────────────────────────────────────────────

function parseArgs(argv: string[]): {
  repo: string;
  session: string;
  issue: string;
  model?: string;
} {
  const args = argv.slice(2);
  let repo = process.cwd();
  let session = '';
  let issue = '';
  let model: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--repo' && args[i + 1]) {
      repo = resolve(args[++i]);
    } else if (arg === '--session' && args[i + 1]) {
      session = args[++i];
    } else if (arg === '--issue' && args[i + 1]) {
      issue = args[++i];
    } else if (arg === '--model' && args[i + 1]) {
      model = args[++i];
    } else if (arg === '--help' || arg === '-h') {
      printUsage();
      process.exit(0);
    }
  }

  if (!session) {
    console.error('Error: --session is required');
    printUsage();
    process.exit(1);
  }
  if (!issue) {
    console.error('Error: --issue is required');
    printUsage();
    process.exit(1);
  }

  return { repo, session, issue, model };
}

function printUsage(): void {
  console.error(
    'Usage: npx tsx tools/launch-claude-deepseek.ts --session <session> --issue <issue> [--repo <dir>] [--model <model>]\n' +
    '\n' +
    'Prints shell-safe KEY=value lines to stdout for eval by a parent shell.\n' +
    'Exit codes: 0=success, 2=missing API key, 1=other error',
  );
}

// ────────────────────────────────────────────────────────────────
// Shell-safe output
// ────────────────────────────────────────────────────────────────

function shellEscape(value: string): string {
  // Single-quote escaping: replace ' with '\''
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function printEnvBlock(env: Record<string, string>): void {
  for (const [key, value] of Object.entries(env)) {
    // Only emit valid shell variable names
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      process.stdout.write(`${key}=${shellEscape(value)}\n`);
    }
  }
}

// ────────────────────────────────────────────────────────────────
// Main
// ────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const { repo, session, issue, model } = parseArgs(process.argv);

  try {
    const env = buildDeepSeekLauncherEnv({ repoDir: repo, session, issue, model });

    // Create state directories before printing env
    createDeepSeekStateDir(env);

    // Write discovery file (no secret content)
    writeDeepSeekStateDiscoveryFile(session, issue, env.WAVEMILL_DEEPSEEK_STATE_DIR);

    // Print env block to stdout for parent shell consumption
    printEnvBlock(env);
  } catch (err) {
    if (err instanceof MissingDeepSeekApiKeyError) {
      console.error(`Error: ${err.message}`);
      process.exit(2);
    }
    if (err instanceof InvalidPathSegmentError || err instanceof UnsafeStateDirError) {
      console.error(`Error: ${err.message}`);
      process.exit(1);
    }
    console.error(`Unexpected error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

main();
