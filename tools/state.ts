#!/usr/bin/env node
// State CLI - Locked JSON state-file operations.
// See docs/cli-reference.md for full documentation and examples.

import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs/promises';
import { getValue, initIfMissing, runJqLocked, atomicWriteJson, withFileLock } from '../shared/lib/state-store.ts';
import { errorMessage } from '../shared/lib/error-utils.ts';

const EXIT_SUCCESS = 0, EXIT_LOCK_TIMEOUT = 2, EXIT_INVALID_INPUT = 3, EXIT_IO_ERROR = 4;

function validatePath(filePath: string): void {
  const norm = path.normalize(path.resolve(filePath));
  const repo = process.cwd();
  if (!norm.startsWith(repo + path.sep) && !norm.startsWith('/tmp/') && !norm.startsWith(os.tmpdir())) {
    throw new Error('Invalid path');
  }
}

function parseJqArgs(args: string[]) {
  const idx = args.indexOf('--');
  if (idx === -1) throw new Error('Missing -- separator for jq expression');
  const parts = args.slice(idx + 1);
  if (parts.length !== 1) throw new Error('Expected exactly one jq expression after --');
  return { jqArgs: args.slice(0, idx), expression: parts[0] };
}

async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    console.log(`State CLI - Locked JSON state-file operations
USAGE: npx tsx tools/state.ts <cmd> <file> [args...]
COMMANDS: get|set|merge|delete|init
See docs/cli-reference.md for full docs`);
    process.exit(EXIT_SUCCESS);
  }

  const [subcommand, filePath, ...rest] = args;

  try {
    if (!filePath) {
      throw new Error('Missing file path argument');
    }

    validatePath(filePath);

    switch (subcommand) {
      case 'get': {
        if (rest.length !== 1) {
          throw new Error('get requires exactly one argument: <jq-expr>');
        }
        try {
          await fs.stat(filePath);
        } catch (err: unknown) {
          const e = err as NodeJS.ErrnoException;
          if (e.code === 'ENOENT') {
            throw new Error(`File not found: ${filePath}`);
          }
          throw err;
        }
        const [jqExpr] = rest;
        const value = await getValue(filePath, jqExpr);
        console.log(JSON.stringify(value, null, 2));
        break;
      }

      case 'set': {
        const { jqArgs, expression } = parseJqArgs(rest);
        await runJqLocked(filePath, expression, jqArgs);
        break;
      }

      case 'merge': {
        if (rest.length !== 1) {
          throw new Error('merge requires exactly one argument: <json-obj>');
        }
        const [jsonObj] = rest;
        let mergeValue: unknown;
        try {
          mergeValue = JSON.parse(jsonObj);
        } catch (err) {
          throw new Error(`Invalid JSON: ${errorMessage(err)}`);
        }

        if (typeof mergeValue !== 'object' || mergeValue === null || Array.isArray(mergeValue)) {
          throw new Error('merge argument must be a JSON object');
        }

        await withFileLock(filePath, async (current) => {
          const merged = { ...(current as object), ...mergeValue };
          await atomicWriteJson(filePath, merged);
        });
        break;
      }

      case 'delete': {
        if (rest.length !== 1) {
          throw new Error('delete requires exactly one argument: <jq-path>');
        }
        const [jqPath] = rest;
        await runJqLocked(filePath, `del(${jqPath}) | .updated = (now | todate)`);
        break;
      }

      case 'init': {
        if (rest.length !== 1) {
          throw new Error('init requires exactly one argument: <json-default>');
        }
        const [jsonDefault] = rest;
        let defaultValue: unknown;
        try {
          defaultValue = JSON.parse(jsonDefault);
        } catch (err) {
          throw new Error(`Invalid JSON: ${errorMessage(err)}`);
        }

        await initIfMissing(filePath, defaultValue);
        break;
      }

      default:
        throw new Error(`Unknown subcommand: ${subcommand}`);
    }

    process.exit(EXIT_SUCCESS);
  } catch (err: unknown) {
    const e = err as Error & { code?: string };
    const msg = errorMessage(err);
    if (e.code === 'LOCK_TIMEOUT') {
      console.error(`Lock timeout: ${msg}`);
      process.exit(EXIT_LOCK_TIMEOUT);
    } else if (e.message?.includes('Invalid') || e.message?.includes('Missing')) {
      console.error(`Invalid input: ${msg}`);
      process.exit(EXIT_INVALID_INPUT);
    } else {
      console.error(`IO error: ${msg}`);
      process.exit(EXIT_IO_ERROR);
    }
  }
}

main();
