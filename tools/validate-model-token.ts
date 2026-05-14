#!/usr/bin/env node
/**
 * validate-model-token - selector-aware model token validator
 *
 * Accepts family aliases (opus, sonnet, haiku), the literal "inherit",
 * and pinned model IDs. Rejects unknown aliases and malformed inputs.
 *
 * Exit 0 + prints normalized token to stdout on success.
 * Exit 1 + prints error to stderr on failure.
 *
 * Usage: npx tsx tools/validate-model-token.ts [--repo-dir <dir>] <token>
 */

import { resolve as resolvePath } from 'node:path';
import { errorMessage } from '../shared/lib/error-utils.ts';
import {
  parseModelSelector,
  type ModelSelector,
} from '../shared/lib/model-registry.ts';
import { validateModelOrThrow } from '../shared/lib/model-validator.ts';

function parseArgs(argv: string[]): { token: string; repoDir: string } {
  const args = argv.slice(2);
  let token = '';
  let repoDir = process.cwd();

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--repo-dir') {
      if (i + 1 >= args.length) {
        throw new Error('--repo-dir requires a value');
      }
      repoDir = args[++i];
    } else if (arg === '--help' || arg === '-h') {
      process.stdout.write(
        'Usage: npx tsx tools/validate-model-token.ts [--repo-dir <dir>] <token>\n' +
        '\n' +
        'Validates a model selector token. Accepted forms:\n' +
        '  family alias: opus, sonnet, haiku\n' +
        '  alias with channel: opus:preview\n' +
        '  inherit\n' +
        '  pinned model ID: claude-sonnet-4-6, claude-opus-4-7\n' +
        '\n' +
        'Prints the normalized token to stdout on success.\n',
      );
      process.exit(0);
    } else if (!arg.startsWith('--')) {
      if (token) {
        throw new Error(`Unexpected extra argument: ${arg}`);
      }
      token = arg;
    } else {
      throw new Error(`Unknown flag: ${arg}`);
    }
  }

  if (!token) {
    throw new Error(
      'Model token argument required.\n' +
      'Usage: npx tsx tools/validate-model-token.ts [--repo-dir <dir>] <token>',
    );
  }

  return { token, repoDir: resolvePath(repoDir) };
}

function normalizeToken(selector: ModelSelector): string {
  switch (selector.kind) {
    case 'inherit':
      return 'inherit';
    case 'alias':
      // Omit 'stable' channel — it is the default and implied by the bare family name
      if (!selector.channel || selector.channel === 'stable') {
        return selector.family;
      }
      return `${selector.family}:${selector.channel}`;
    case 'pinned':
      return selector.modelId;
    default: {
      const _exhaustive: never = selector;
      throw new Error(`Unhandled selector kind: ${JSON.stringify(_exhaustive)}`);
    }
  }
}

async function main(): Promise<void> {
  let token: string;
  let repoDir: string;

  try {
    ({ token, repoDir } = parseArgs(process.argv));
  } catch (err) {
    console.error(errorMessage(err));
    process.exit(1);
  }

  const result = parseModelSelector(token);
  if (!result.ok) {
    console.error(result.error.message);
    process.exit(1);
  }

  const { selector } = result;

  // For pinned selectors, validate against known model IDs in config/registry.
  // Aliases and inherit are accepted purely by the registry definition.
  if (selector.kind === 'pinned') {
    try {
      validateModelOrThrow(selector.modelId, repoDir);
    } catch (err) {
      console.error(errorMessage(err));
      process.exit(1);
    }
  }

  process.stdout.write(`${normalizeToken(selector)}\n`);
}

main().catch((err) => {
  console.error(errorMessage(err));
  process.exit(1);
});
