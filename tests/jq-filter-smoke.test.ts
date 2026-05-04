/**
 * Compile-check every `jq -n …` filter literal in the mill shell scripts.
 *
 * Mill startup builds JSON payloads via inline jq filters wrapped in single
 * quotes inside bash heredocs. bash's syntax check (`bash -n`) treats those
 * filters as opaque strings, and `shellcheck` doesn't parse jq either, so a
 * malformed filter (a missing comma, an unbalanced brace) is invisible until
 * mill actually runs and jq tries to compile it. This has bitten us at least
 * once when a missed comma in `route_payload` blocked mill startup
 * (HOK-1497 / PR #506).
 *
 * The test scans each tracked shell file for `jq -n …` blocks, extracts the
 * filter and its `--arg` / `--argjson` declarations, and runs `jq -n` with
 * placeholder values for each declared variable. A compile error makes the
 * test fail with the line number of the offending block.
 *
 * Scope: jq COMPILE errors only. Runtime semantics (e.g. iterating over a
 * null `--argjson`) are out of scope; placeholders are deliberately benign.
 */

import { readFileSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');

const FILES_TO_SCAN = [
  'shared/lib/wavemill-mill.sh',
  'shared/lib/wavemill-startup-runner.sh',
  'shared/lib/wavemill-common.sh',
];

interface JqBlock {
  file: string;
  startLine: number;
  argNames: { name: string; type: 'arg' | 'argjson' }[];
  filter: string;
}

/**
 * Walk `content` and yield every `jq -n …` block. Each block is the args
 * (one per line) followed by a single-quoted filter literal that may span
 * multiple lines.
 */
function extractJqBlocks(file: string, content: string): JqBlock[] {
  const blocks: JqBlock[] = [];
  const lines = content.split('\n');

  for (let i = 0; i < lines.length; i++) {
    // Match `jq -n` at the start of an invocation, possibly with extra flags
    // like -c or -r. Word-boundaried to avoid matching `gh pr checks --jq -n`.
    if (!/(?:^|[^\w-])jq\s+-n(\s|\\|$)/.test(lines[i])) continue;

    const startLine = i + 1;
    const argNames: JqBlock['argNames'] = [];
    let filterStartLine = -1;

    let j = i;
    // First, gather --arg/--argjson declarations from the call invocation.
    // The filter is the first argument that looks like a single-quoted string.
    // Continuation lines end with `\`; the filter itself is single-quoted.
    while (j < lines.length) {
      const line = lines[j];

      // Check for --arg / --argjson declarations on this line.
      const argMatches = [...line.matchAll(/--arg(json)?\s+(\w+)\s+/g)];
      for (const m of argMatches) {
        argNames.push({ name: m[2], type: m[1] ? 'argjson' : 'arg' });
      }

      // Check whether this line opens the filter (first single quote that
      // isn't part of a `--arg name 'value'` literal).
      const quoteIdx = findFilterOpenQuote(line);
      if (quoteIdx >= 0) {
        filterStartLine = j;
        break;
      }

      // If the line doesn't end with a continuation `\`, the jq invocation
      // ended without a filter (unusual — skip it).
      if (!line.trimEnd().endsWith('\\')) break;
      j++;
    }

    if (filterStartLine < 0) {
      i = j;
      continue;
    }

    // Read the filter contents starting at the open quote, ending at the
    // matching close quote (single quotes can't be escaped in bash, so the
    // first subsequent ' terminates).
    const filter = readFilterContents(lines, filterStartLine);
    if (filter === null) {
      i = filterStartLine;
      continue;
    }

    blocks.push({ file, startLine, argNames, filter });
    i = filterStartLine; // outer loop will advance past this
  }

  return blocks;
}

/**
 * Find the index of the single quote that opens the filter on `line`, or -1
 * if no filter starts on this line. Skips quotes that are values for
 * preceding `--arg`/`--argjson` declarations on the same line.
 */
function findFilterOpenQuote(line: string): number {
  // Strip --arg name 'value' and --argjson name 'value' literals so they
  // don't confuse us. Replace each with spaces of equal length to preserve
  // column counts.
  const stripped = line.replace(
    /(--arg(?:json)?\s+\w+\s+)('(?:[^']|'')*')/g,
    (_, prefix, val) => prefix + ' '.repeat(val.length),
  );
  return stripped.indexOf("'");
}

/**
 * Read a single-quoted filter starting at `lines[start]`. Returns the filter
 * contents (without the surrounding quotes) or null if no closing quote is
 * found.
 */
function readFilterContents(lines: string[], start: number): string | null {
  const openCol = findFilterOpenQuote(lines[start]);
  if (openCol < 0) return null;

  // First-line content after the open quote.
  let buf = lines[start].substring(openCol + 1);

  // If the first line itself contains the closing quote, we're done.
  const sameLineClose = buf.indexOf("'");
  if (sameLineClose >= 0) {
    return buf.substring(0, sameLineClose);
  }

  // Otherwise read forward until a line containing a single quote.
  for (let k = start + 1; k < lines.length; k++) {
    const line = lines[k];
    const closeIdx = line.indexOf("'");
    if (closeIdx >= 0) {
      buf += '\n' + line.substring(0, closeIdx);
      return buf;
    }
    buf += '\n' + line;
  }

  return null;
}

/**
 * Run `jq -n` against the filter with placeholder values for each declared
 * variable. Returns an error message on compile failure, or null otherwise.
 *
 * Defense in depth — placeholders are tuned per arg name (so common shapes
 * like `defaults` or `tasks` get a useful value, avoiding spurious runtime
 * errors), AND the exit code is filtered to 3 (compile error). jq exits 5
 * on runtime errors and 0 on success; only 3 is a real compile failure
 * worth surfacing to this test.
 */
function compileCheck(block: JqBlock): string | null {
  const args: string[] = ['jq', '-n'];
  for (const arg of block.argNames) {
    if (arg.type === 'arg') {
      args.push('--arg', arg.name, placeholderArg(arg.name));
    } else {
      args.push('--argjson', arg.name, placeholderArgjson(arg.name));
    }
  }
  args.push(block.filter);
  try {
    execSync(args[0] + ' ' + args.slice(1).map(shellQuote).join(' '), {
      stdio: 'pipe',
    });
    return null;
  } catch (err: unknown) {
    const e = err as { stderr?: Buffer; message?: string; status?: number };
    // Exit 3 = compile error (what we want to catch).
    // Exit 5 = runtime error from a placeholder shape mismatch — out of
    // scope here. Anything else (signal, jq missing) we also ignore so a
    // CI environment without jq doesn't fail the suite spuriously.
    if (e.status !== 3) return null;
    const stderr = e.stderr?.toString() ?? '';
    const message = e.message ?? '';
    return stderr.trim() || message.trim() || 'unknown jq compile error';
  }
}

function placeholderArg(name: string): string {
  if (/^(maxParallel|pollSeconds|maxRetries|retryDelay|maxSelect|maxDisplay|planMaxDisplay)$/i.test(name)) {
    return '1';
  }
  return '';
}

function placeholderArgjson(name: string): string {
  if (name === 'defaults') {
    return JSON.stringify({
      linear: {},
      git: {},
      mill: {
        session: '',
        maxParallel: 1,
        pollSeconds: 1,
        baseBranch: '',
        worktreeRoot: '',
        agentCmd: '',
        requireConfirm: false,
        planningMode: '',
        maxRetries: 0,
        retryDelay: 0,
      },
      expand: { maxSelect: 1, maxDisplay: 1 },
      plan: { maxDisplay: 1 },
      dashboard: {},
      taskSelection: {},
      challenge: {},
      router: {},
    });
  }
  if (/^(user|repo|local|route|p|queuePlan)$/i.test(name)) return '{}';
  if (/^(tasks|t|labels)$/i.test(name)) return '[]';
  if (/^(m|maxCostUsd)$/i.test(name)) return '1';
  return 'null';
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

test('every jq -n filter literal in mill shell scripts compiles', () => {
  const failures: string[] = [];
  let total = 0;

  for (const fileRel of FILES_TO_SCAN) {
    const path = join(REPO_ROOT, fileRel);
    if (!existsSync(path)) {
      failures.push(`${fileRel}: file not found`);
      continue;
    }
    const content = readFileSync(path, 'utf-8');
    const blocks = extractJqBlocks(fileRel, content);
    for (const block of blocks) {
      total++;
      const error = compileCheck(block);
      if (error) {
        failures.push(`${block.file}:${block.startLine} (${block.argNames.length} args)\n${error}`);
      }
    }
  }

  if (failures.length > 0) {
    assert.fail(
      `\n${failures.length} jq filter(s) failed to compile (of ${total} scanned):\n\n` +
        failures.map((f) => `  - ${f.replace(/\n/g, '\n    ')}`).join('\n\n'),
    );
  }
  // Sanity: we should be finding at least a few blocks. If extraction
  // silently broke, the test would pass with `total === 0` and miss real
  // regressions. A floor catches that.
  assert.ok(total >= 5, `expected at least 5 jq -n blocks, found ${total}`);
});

test('extractor catches a deliberately broken filter', () => {
  // Regression guard: simulate the comma-missing bug from PR #506. If the
  // extractor or compileCheck regress and silently treat malformed filters
  // as OK, this test fails.
  const synthetic = `
some_function() {
  jq -n \\
    --arg foo "$bar" \\
    --argjson baz "$qux" \\
    '{
      foo: $foo
      baz: $baz
    }'
}
  `;
  const blocks = extractJqBlocks('synthetic.sh', synthetic);
  assert.equal(blocks.length, 1, 'should extract exactly one jq block');
  const err = compileCheck(blocks[0]);
  assert.ok(err, 'expected the malformed filter to fail compile-check');
  assert.match(err, /syntax error|parse error|compile/i);
});
