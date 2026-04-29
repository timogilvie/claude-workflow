#!/usr/bin/env node
/**
 * State CLI - Locked JSON state-file operations.
 *
 * Provides safe concurrent access to JSON state files via file locking.
 * All write operations are atomic and protected by exclusive locks.
 *
 * ## Subcommands
 *
 * - `get <file> <jq-expr>` - Read value at path (no lock)
 * - `set <file> <jq-expr> [--arg k v]... [--argjson k v]...` - Locked jq transform
 * - `merge <file> <json-obj>` - Locked shallow merge
 * - `delete <file> <jq-path>` - Locked deletion
 * - `init <file> <json-default>` - Create file if missing (locked)
 *
 * ## Exit Codes
 *
 * - 0: Success
 * - 2: Lock timeout (contention)
 * - 3: Invalid input
 * - 4: File/IO error
 *
 * ## Examples
 *
 * ```bash
 * # Read a value
 * npx tsx tools/state.ts get /tmp/state.json '.tasks["HOK-123"].status'
 *
 * # Update with jq expression
 * npx tsx tools/state.ts set /tmp/state.json --arg issue "HOK-123" --arg status "done" \
 *   -- '.tasks[$issue].status = $status | .updated = (now | todate)'
 *
 * # Merge an object
 * npx tsx tools/state.ts merge /tmp/state.json '{"activeSlots": 5}'
 *
 * # Delete a key
 * npx tsx tools/state.ts delete /tmp/state.json '.tasks["HOK-123"]'
 *
 * # Initialize with default
 * npx tsx tools/state.ts init /tmp/state.json '{"tasks": {}, "migrations": []}'
 * ```
 */

import * as path from 'node:path';
import * as os from 'node:os';
import { getValue, initIfMissing, runJqLocked, atomicWriteJson, withFileLock, LOCK_TIMEOUT_EXIT_CODE } from '../shared/lib/state-store.ts';
import { errorMessage } from '../shared/lib/error-utils.ts';

// Exit codes
const EXIT_SUCCESS = 0;
const EXIT_LOCK_TIMEOUT = 2;
const EXIT_INVALID_INPUT = 3;
const EXIT_IO_ERROR = 4;

/**
 * Validate that a file path is safe (no directory traversal).
 * Allowed: paths within repo root, /tmp/, or OS temp dir
 */
function validatePath(filePath: string): void {
  const resolved = path.resolve(filePath);
  const repoRoot = process.cwd();
  const tmpDir = os.tmpdir();
  const normalizedPath = path.normalize(resolved);

  // Check for directory traversal
  if (normalizedPath.includes('..')) {
    throw new Error(`Invalid path: directory traversal not allowed`);
  }

  // Must be within repo root, /tmp/, or OS temp directory
  const isInRepo = normalizedPath.startsWith(repoRoot);
  const isInTmp = normalizedPath.startsWith('/tmp/');
  const isInTmpDir = normalizedPath.startsWith(tmpDir);

  if (!isInRepo && !isInTmp && !isInTmpDir) {
    throw new Error(`Invalid path: must be within repo root or temp directory`);
  }
}

/**
 * Parse command-line arguments into jq args and expression.
 */
function parseJqArgs(args: string[]): { jqArgs: string[]; expression: string } {
  const dashDashIndex = args.indexOf('--');
  if (dashDashIndex === -1) {
    throw new Error('Missing jq expression (use -- to separate expression from args)');
  }

  const jqArgs = args.slice(0, dashDashIndex);
  const expressionParts = args.slice(dashDashIndex + 1);

  if (expressionParts.length === 0) {
    throw new Error('Missing jq expression after --');
  }
  if (expressionParts.length > 1) {
    throw new Error('Too many arguments after -- (expected single jq expression)');
  }

  return { jqArgs, expression: expressionParts[0] };
}

/**
 * Main CLI entry point.
 */
async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    console.log(`
State CLI - Locked JSON state-file operations

USAGE:
  npx tsx tools/state.ts <subcommand> <file> <args...>

SUBCOMMANDS:
  get <file> <jq-expr>
      Read value at JSON path (no lock needed)

  set <file> [--arg k v]... [--argjson k v]... -- <jq-expr>
      Run jq expression with locking and atomic write
      Use -- to separate jq arguments from expression

  merge <file> <json-obj>
      Shallow merge JSON object into root (locked)

  delete <file> <jq-path>
      Delete key at path using jq del() (locked)

  init <file> <json-default>
      Create file with default JSON if missing (locked)

EXIT CODES:
  0   Success
  2   Lock timeout (contention)
  3   Invalid input
  4   File/IO error

EXAMPLES:
  # Read status
  npx tsx tools/state.ts get /tmp/state.json '.tasks["HOK-123"].status'

  # Update with jq
  npx tsx tools/state.ts set /tmp/state.json --arg issue "HOK-123" \\
    -- '.tasks[$issue].status = "done"'

  # Merge object
  npx tsx tools/state.ts merge /tmp/state.json '{"activeSlots": 5}'

  # Delete key
  npx tsx tools/state.ts delete /tmp/state.json '.tasks["HOK-123"]'

  # Initialize
  npx tsx tools/state.ts init /tmp/state.json '{"tasks": {}}'
`);
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
    const error = err as Error & { code?: string };

    // Map error types to exit codes
    if (error.code === 'LOCK_TIMEOUT') {
      console.error(`Lock timeout: ${errorMessage(err)}`);
      process.exit(EXIT_LOCK_TIMEOUT);
    } else if (error.message?.includes('Invalid') || error.message?.includes('Missing')) {
      console.error(`Invalid input: ${errorMessage(err)}`);
      process.exit(EXIT_INVALID_INPUT);
    } else {
      console.error(`IO error: ${errorMessage(err)}`);
      process.exit(EXIT_IO_ERROR);
    }
  }
}

main();
