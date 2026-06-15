#!/usr/bin/env -S npx tsx

import { resolve } from 'node:path';
import {
  buildOpenRouterLauncherEnv,
  createOpenRouterStateDir,
  writeOpenRouterStateDiscoveryFile,
  InvalidOpenRouterModelError,
  InvalidPathSegmentError,
  MissingOpenRouterApiKeyError,
} from '../shared/lib/openrouter-launcher.ts';

function parseArgs(argv: string[]): {
  repo: string;
  session: string;
  issue: string;
  model: string;
} {
  const args = argv.slice(2);
  let repo = process.cwd();
  let session = '';
  let issue = '';
  let model = '';

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

  if (!session || !issue || !model) {
    console.error('Error: --session, --issue, and --model are required');
    printUsage();
    process.exit(1);
  }

  return { repo, session, issue, model };
}

function printUsage(): void {
  console.error(
    'Usage: npx tsx tools/launch-claude-openrouter.ts --session <session> --issue <issue> --model <model> [--repo <dir>]',
  );
}

function shellEscape(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function printEnvBlock(env: Record<string, string>): void {
  for (const [key, value] of Object.entries(env)) {
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      process.stdout.write(`${key}=${shellEscape(value)}\n`);
    }
  }
}

async function main(): Promise<void> {
  const { repo, session, issue, model } = parseArgs(process.argv);

  try {
    const env = buildOpenRouterLauncherEnv({ repoDir: repo, session, issue, model });
    createOpenRouterStateDir(env);
    writeOpenRouterStateDiscoveryFile(session, issue, env.WAVEMILL_OPENROUTER_STATE_DIR);
    printEnvBlock(env);
  } catch (err) {
    if (err instanceof MissingOpenRouterApiKeyError) {
      console.error(`Error: ${err.message}`);
      process.exit(2);
    }
    if (err instanceof InvalidOpenRouterModelError || err instanceof InvalidPathSegmentError) {
      console.error(`Error: ${err.message}`);
      process.exit(1);
    }
    console.error(`Unexpected error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

main();
