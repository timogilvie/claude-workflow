/**
 * Characterizes duplicated shell functions in the parent mill script and its
 * embedded monitor. Keep these copies frozen until the monitor is extracted.
 *
 * This deliberately parses only the function declaration style currently used
 * by the script: a column-zero `name() {` followed by a column-zero `}`. It is
 * heredoc-aware because a heredoc payload may itself contain a column-zero `}`.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const MILL_SCRIPT_PATH = join(REPO_ROOT, 'shared', 'lib', 'wavemill-mill.sh');
const MILL_SCRIPT_DISPLAY_PATH = 'shared/lib/wavemill-mill.sh';

const IDENTICAL_EXPECTED = [
  '_global_operating_mode',
  '_log_level_num',
  '_mirror_to_mill_log',
  '_update_effective_max_parallel',
  'append_status_log',
  'challenge_eval_hard_failure_max_retries',
  'challenge_eval_retry_max_attempts',
  'challenge_pair_hard_failure_reason',
  'challenge_pair_manual_artifact_path',
  'challenge_pair_record_exists',
  'challenge_pair_records_file',
  'challenge_pair_timed_out_sides_csv',
  'challenge_pair_timeout_reason',
  'challenge_plan_stage_requires_effective_route',
  'challenge_pr_url_from_number',
  'check_routing_complete',
  'clear_challenge_pair_state',
  'codex_has_pending_approval',
  'indent_block',
  'invoke_first_wave_helper',
  'log',
  'log_challenge_unavailable_plan',
  'log_error',
  'log_task',
  'log_warn',
  'mark_challenge_comparison_running',
  'mark_challenge_eval_running',
  'render_prompt_template',
  'replay_route_transparency_logs',
  'save_migration_reservation',
  'set_task_phase',
  'set_window_attention_state',
  'write_challenge_pair_state',
  'write_manual_challenge_comparison_artifact',
] as const;

const DIVERGENT_ALLOWLIST = [
  '_with_timeout',
  'cleanup_completed_task',
  'cleanup_remote_task_branch',
  'get_task_phase',
  'linear_is_completed',
  'linear_set_state',
  'pr_state',
  'remove_task_state',
  'resolve_challenge_pair_hard_failure',
  'save_task_state',
  'validate_pr_merge',
] as const;

type Side = 'parent' | 'monitor';

interface FunctionDef {
  name: string;
  side: Side;
  startLine: number;
  endLine: number;
  body: string;
}

interface Heredoc {
  tag: string;
  allowLeadingTabs: boolean;
}

interface MonitorHeredocRange {
  /** Zero-based index of the opening redirect line. */
  openerLine: number;
  /** Zero-based index of the terminator line. */
  terminatorLine: number;
}

interface ExtractionResult {
  fns: FunctionDef[];
  monitorRange: [number, number];
}

const FUNCTION_START = /^([A-Za-z_][A-Za-z0-9_]*)\(\)[ \t]*\{[ \t]*$/;
const FUNCTION_END = /^\}[ \t]*$/;

function assertSortedUnique(values: readonly string[], label: string): void {
  const sorted = [...values].sort();
  assert.deepEqual(
    [...values],
    sorted,
    `${label} must stay sorted so changes are deliberate and reviewable.`,
  );
  assert.equal(new Set(values).size, values.length, `${label} must not contain duplicate names.`);
}

/**
 * Returns the first conventional shell heredoc opener on a line. The monitor
 * script only uses one opener per line; supporting a queue of several openers
 * would make the parser more complex without improving this characterization
 * test. Quoted and tab-stripped delimiters are accepted defensively.
 */
function parseHeredocOpener(line: string): Heredoc | null {
  // Shell arithmetic also uses `<<`; heredoc tags in this script are shell
  // identifiers, so require that shape to avoid treating `1 << (value)` as a
  // heredoc. This intentionally matches the documented parser contract.
  const match = /(?<!<)(<<-?)(?!<)[ \t]*(?:'([A-Za-z_][A-Za-z0-9_]*)'|"([A-Za-z_][A-Za-z0-9_]*)"|([A-Za-z_][A-Za-z0-9_]*))/.exec(line);
  if (!match) return null;

  const tag = match[2] ?? match[3] ?? match[4];
  if (!tag) return null;
  return { tag, allowLeadingTabs: match[1] === '<<-' };
}

function isHeredocTerminator(line: string, heredoc: Heredoc): boolean {
  const candidate = line.replace(/\r?\n$/, '');
  return heredoc.allowLeadingTabs
    ? candidate.replace(/^\t+/, '') === heredoc.tag
    : candidate === heredoc.tag;
}

/**
 * Finds the outer monitor heredoc in actual shell source. Its payload is not
 * scanned for nested openers here: those lines are data to the parent shell,
 * and are scanned as shell source only in extractFunctionsFromRange below.
 */
function findMonitorHeredoc(lines: readonly string[]): MonitorHeredocRange {
  let active: Heredoc | null = null;
  let activeOpenerLine = -1;
  const ranges: MonitorHeredocRange[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (active) {
      if (isHeredocTerminator(line, active)) {
        if (active.tag === 'MONITOR_EOF') {
          ranges.push({ openerLine: activeOpenerLine, terminatorLine: index });
        }
        active = null;
      }
      continue;
    }

    const heredoc = parseHeredocOpener(line);
    if (heredoc) {
      active = heredoc;
      activeOpenerLine = index;
    }
  }

  assert.equal(
    ranges.length,
    1,
    ranges.length === 0
      ? 'No MONITOR_EOF heredoc found. Delete this characterization test and its unit-suite entry when the monitor is extracted.'
      : `Expected one MONITOR_EOF heredoc, found ${ranges.length}. Update this test explicitly for the new structure.`,
  );
  assert.equal(active, null, `Unterminated heredoc ${active?.tag ?? ''} while locating MONITOR_EOF.`);
  return ranges[0]!;
}

/** Extract functions from a source partition, while ignoring nested heredoc data. */
function extractFunctionsFromRange(
  lines: readonly string[],
  startIndex: number,
  endIndex: number,
  side: Side,
): FunctionDef[] {
  const fns: FunctionDef[] = [];
  let activeHeredoc: Heredoc | null = null;
  let current: { name: string; startIndex: number } | null = null;

  for (let index = startIndex; index < endIndex; index += 1) {
    const line = lines[index];

    if (activeHeredoc) {
      if (isHeredocTerminator(line, activeHeredoc)) activeHeredoc = null;
      continue;
    }

    const heredoc = parseHeredocOpener(line);
    if (heredoc) {
      activeHeredoc = heredoc;
      continue;
    }

    if (!current) {
      const functionStart = FUNCTION_START.exec(line.replace(/\r?\n$/, ''));
      if (functionStart) current = { name: functionStart[1]!, startIndex: index };
      continue;
    }

    if (FUNCTION_END.test(line.replace(/\r?\n$/, ''))) {
      fns.push({
        name: current.name,
        side,
        startLine: current.startIndex + 1,
        endLine: index + 1,
        body: lines.slice(current.startIndex, index + 1).join(''),
      });
      current = null;
    }
  }

  assert.equal(activeHeredoc, null, `Unterminated heredoc ${activeHeredoc?.tag ?? ''} in ${side} partition.`);
  assert.equal(
    current,
    null,
    current ? `Unterminated function ${current.name} in ${side} partition.` : '',
  );
  return fns;
}

function extractFunctions(content: string): ExtractionResult {
  const lines = content.split(/(?<=\n)/);
  const monitor = findMonitorHeredoc(lines);
  const fns = [
    ...extractFunctionsFromRange(lines, 0, monitor.openerLine, 'parent'),
    ...extractFunctionsFromRange(lines, monitor.openerLine + 1, monitor.terminatorLine, 'monitor'),
    ...extractFunctionsFromRange(lines, monitor.terminatorLine + 1, lines.length, 'parent'),
  ];
  return { fns, monitorRange: [monitor.openerLine + 1, monitor.terminatorLine + 1] };
}

function functionLocation(fn: FunctionDef): string {
  return `${MILL_SCRIPT_DISPLAY_PATH}:${fn.startLine}-${fn.endLine}`;
}

function pairHeading(name: string, parent: FunctionDef, monitor: FunctionDef): string {
  return `FUNCTION: ${name}\n  parent:  ${functionLocation(parent)}\n  monitor: ${functionLocation(monitor)}`;
}

function fallbackLineDiff(parent: FunctionDef, monitor: FunctionDef): string {
  const parentLines = parent.body.split(/(?<=\n)/);
  const monitorLines = monitor.body.split(/(?<=\n)/);
  const output = ['--- parent', '+++ monitor', '@@ line-by-line fallback @@'];
  const maximum = Math.max(parentLines.length, monitorLines.length);

  for (let index = 0; index < maximum && output.length < 63; index += 1) {
    if (parentLines[index] === monitorLines[index]) continue;
    if (parentLines[index] !== undefined) output.push(`-${parentLines[index]!.replace(/\n$/, '')}`);
    if (monitorLines[index] !== undefined) output.push(`+${monitorLines[index]!.replace(/\n$/, '')}`);
  }
  return output.join('\n');
}

function renderDiff(name: string, parent: FunctionDef, monitor: FunctionDef): string {
  const tempDir = mkdtempSync(join(tmpdir(), 'wavemill-parent-monitor-drift-'));
  const parentPath = join(tempDir, 'parent.sh');
  const monitorPath = join(tempDir, 'monitor.sh');

  try {
    writeFileSync(parentPath, parent.body);
    writeFileSync(monitorPath, monitor.body);
    const result = spawnSync('diff', ['-u', parentPath, monitorPath], { encoding: 'utf8' });
    if (!result.error && (result.status === 0 || result.status === 1) && result.stdout) {
      const lines = result.stdout.split('\n');
      lines[0] = `--- parent ${name} (${functionLocation(parent)})`;
      lines[1] = `+++ monitor ${name} (${functionLocation(monitor)})`;
      return lines.slice(0, 60).join('\n');
    }
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }

  return fallbackLineDiff(parent, monitor);
}

function assertExactSet(
  actual: Iterable<string>,
  expected: readonly string[],
  label: string,
  pairs: ReadonlyMap<string, { parent: FunctionDef; monitor: FunctionDef }>,
  includeDiff = false,
): void {
  const actualSet = new Set(actual);
  const expectedSet = new Set(expected);
  const unexpected = [...actualSet].filter(name => !expectedSet.has(name)).sort();
  const missing = [...expectedSet].filter(name => !actualSet.has(name)).sort();
  if (unexpected.length === 0 && missing.length === 0) return;

  const details = unexpected.map(name => {
    const pair = pairs.get(name);
    if (!pair) return `FUNCTION: ${name}`;
    return includeDiff
      ? `${pairHeading(name, pair.parent, pair.monitor)}\n${renderDiff(name, pair.parent, pair.monitor)}`
      : pairHeading(name, pair.parent, pair.monitor);
  });
  assert.fail([
    `${label} changed; update this characterization test explicitly after reconciling the change.`,
    missing.length > 0 ? `Missing: ${missing.join(', ')}` : '',
    unexpected.length > 0 ? `Unexpected: ${unexpected.join(', ')}` : '',
    ...details,
  ].filter(Boolean).join('\n'));
}

const source = readFileSync(MILL_SCRIPT_PATH, 'utf8');
const extracted = extractFunctions(source);
const byName = new Map<string, Partial<Record<Side, FunctionDef>>>();

for (const fn of extracted.fns) {
  const pair = byName.get(fn.name) ?? {};
  // Bash resolves repeated definitions to the last one executed. The monitor
  // currently repeats save_migration_reservation, so retain that effective
  // definition rather than making an unrelated same-side duplication fail.
  pair[fn.side] = fn;
  byName.set(fn.name, pair);
}

const sharedPairs = new Map<string, { parent: FunctionDef; monitor: FunctionDef }>();
for (const [name, pair] of byName) {
  if (pair.parent && pair.monitor) sharedPairs.set(name, { parent: pair.parent, monitor: pair.monitor });
}

const sharedNames = [...sharedPairs.keys()].sort();
const actualIdentical = sharedNames.filter(name => {
  const pair = sharedPairs.get(name)!;
  return pair.parent.body === pair.monitor.body;
});
const actualDivergent = sharedNames.filter(name => !actualIdentical.includes(name));

describe('parent/monitor drift', () => {
  assertSortedUnique(IDENTICAL_EXPECTED, 'IDENTICAL_EXPECTED');
  assertSortedUnique(DIVERGENT_ALLOWLIST, 'DIVERGENT_ALLOWLIST');

  it('discovers exactly the frozen shared function names', () => {
    const expectedShared = [...IDENTICAL_EXPECTED, ...DIVERGENT_ALLOWLIST].sort();
    assertExactSet(
      sharedNames,
      expectedShared,
      'Discovered shared parent/monitor function set',
      sharedPairs,
    );
    assert.equal(sharedNames.length, 45, 'Baseline must contain exactly 45 shared parent/monitor functions.');
  });

  it('keeps all frozen identical function bodies byte-identical', () => {
    for (const name of IDENTICAL_EXPECTED) {
      const pair = sharedPairs.get(name);
      assert.ok(pair, `Expected identical function ${name} was not found in both parent and monitor.`);
      if (pair.parent.body !== pair.monitor.body) {
        assert.fail(`${pairHeading(name, pair.parent, pair.monitor)}\n${renderDiff(name, pair.parent, pair.monitor)}`);
      }
    }
  });

  it('allows exactly the frozen divergent function bodies', () => {
    for (const name of DIVERGENT_ALLOWLIST) {
      const pair = sharedPairs.get(name);
      assert.ok(pair, `Expected allowlisted divergent function ${name} was not found in both parent and monitor.`);
      assert.notEqual(
        pair.parent.body,
        pair.monitor.body,
        `${pairHeading(name, pair.parent, pair.monitor)}\nAllowlisted function is now byte-identical; remove it from DIVERGENT_ALLOWLIST or reconcile the copies explicitly.`,
      );
    }
    assertExactSet(
      actualDivergent,
      DIVERGENT_ALLOWLIST,
      'Divergent parent/monitor function set',
      sharedPairs,
      true,
    );
  });

  it('has no unclassified shared function or silent bucket swap', () => {
    const classified = new Set([...actualIdentical, ...actualDivergent]);
    assertExactSet(
      classified,
      sharedNames,
      'Classified parent/monitor function set',
      sharedPairs,
    );
    assert.equal(
      actualIdentical.filter(name => actualDivergent.includes(name)).length,
      0,
      'A shared function cannot be both identical and divergent.',
    );
    assertExactSet(actualIdentical, IDENTICAL_EXPECTED, 'Identical parent/monitor function set', sharedPairs);
    assertExactSet(actualDivergent, DIVERGENT_ALLOWLIST, 'Divergent parent/monitor function set', sharedPairs, true);
  });
});
