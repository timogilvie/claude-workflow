/**
 * Config/schema integrity probe used by the observer.
 *
 * The observer runs this each tick to detect a malformed
 * `wavemill-config.schema.json` or a broken `.wavemill-config.json` /
 * `.wavemill-config.local.json` / `~/.wavemill/config.json` file. A single
 * such failure otherwise kills every wavemill TypeScript entrypoint fleet-wide
 * and surfaces as N unrelated-looking per-tool symptoms (silent model
 * downgrades, ready-watchdog crashes, eval failures).
 *
 * Contract:
 * - Never throws. Every fs / parse / compile step is guarded, and unexpected
 *   errors surface as issues themselves rather than propagating.
 * - Probes the same schema path production code resolves (worktree schema when
 *   present, canonical schema otherwise), so the checker cannot drift from the
 *   file that actually kills entrypoints.
 * - The final merged-validation probe reuses `loadWavemillConfig`, so schema
 *   validation, `validateReadyPolicySubset`, and `validateAgentsModelSelectors`
 *   are exercised end-to-end without reimplementation.
 *
 * @module config-integrity
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';

import { clearConfigCache, loadWavemillConfig } from './config.ts';
import { errorMessage } from './error-utils.ts';

export type ConfigIntegrityKind =
  | 'schema-parse'
  | 'schema-compile'
  | 'config-parse'
  | 'config-validate';

/**
 * A single integrity failure. `position`/`line`/`column`/`excerpt` are best
 * effort — they are populated when the underlying error message carries a
 * character offset, and absent otherwise.
 */
export interface ConfigIntegrityIssue {
  /** Absolute path of the offending file. */
  file: string;
  kind: ConfigIntegrityKind;
  /** Underlying error message. */
  message: string;
  /** 0-based character offset, when derivable from the JSON error. */
  position?: number;
  /** 1-based line number of the offending byte. */
  line?: number;
  /** 1-based column number of the offending byte. */
  column?: number;
  /** ~60-char single-line excerpt around the offending position. */
  excerpt?: string;
}

export interface CheckConfigIntegrityOptions {
  repoDir: string;
  /** Overridden home dir, for tests. Defaults to `os.homedir()`. */
  homeDir?: string;
}

interface CompiledSchemaEntry {
  compiledAt: number;
  mtimeMs: number;
  size: number;
}

// Fingerprint-cached OK results for the schema-compile probe. We cache success
// only — a failing probe is cheap to redo and must never be masked.
const compiledSchemaOk = new Map<string, CompiledSchemaEntry>();

// One-time module warning if ajv is unavailable. We swallow the compile probe
// silently in that case (mirrors config.ts's own MODULE_NOT_FOUND handling)
// but only want to warn once per process.
let didWarnAjvMissing = false;

/**
 * Probe schema + config file integrity for one repo directory.
 *
 * Order:
 *  1. Schema parse (fresh read of the schema file production code resolves).
 *  2. Schema Ajv compile (skipped when ajv is unavailable — parse still runs).
 *  3. `.wavemill-config.json`, `.wavemill-config.local.json`,
 *     `~/.wavemill/config.json` parse.
 *  4. Merged validation via `loadWavemillConfig`, run only when 1–3 found
 *     nothing — this reuses the exact production failure path so schema and
 *     subset validators cannot drift.
 *
 * @returns Zero or more integrity issues. Empty result means config is loadable.
 */
export function checkConfigIntegrity(options: CheckConfigIntegrityOptions): ConfigIntegrityIssue[] {
  const issues: ConfigIntegrityIssue[] = [];
  const repoDir = resolve(options.repoDir);
  const homeDir = options.homeDir ?? homedir();
  const schemaPath = resolveSchemaPath(repoDir);

  // ── Probe 1: schema parse ─────────────────────────────────────────────
  let schemaContent: string | null = null;
  try {
    if (existsSync(schemaPath)) {
      schemaContent = readFileSync(schemaPath, 'utf-8');
    }
  } catch (err) {
    issues.push({
      file: schemaPath,
      kind: 'schema-parse',
      message: `Failed to read schema: ${errorMessage(err)}`,
    });
    return issues;
  }

  if (schemaContent === null) {
    issues.push({
      file: schemaPath,
      kind: 'schema-parse',
      message: `Schema file not found at ${schemaPath}`,
    });
    return issues;
  }

  let schema: unknown;
  try {
    schema = JSON.parse(schemaContent);
  } catch (err) {
    issues.push(buildParseIssue(schemaPath, 'schema-parse', schemaContent, err));
    return issues;
  }

  // ── Probe 2: schema Ajv compile ───────────────────────────────────────
  const fingerprint = statFingerprint(schemaPath);
  const cachedCompile = compiledSchemaOk.get(schemaPath);
  const cacheHit =
    cachedCompile &&
    fingerprint &&
    cachedCompile.mtimeMs === fingerprint.mtimeMs &&
    cachedCompile.size === fingerprint.size;

  if (!cacheHit) {
    const compileResult = tryAjvCompile(schema);
    if (compileResult === 'ajv-missing') {
      // Parse probes remain valid; skip compile probe silently after warning
      // once per process (matches config.ts's own behavior).
    } else if (compileResult instanceof Error) {
      issues.push({
        file: schemaPath,
        kind: 'schema-compile',
        message: `Failed to compile schema: ${errorMessage(compileResult)}`,
      });
      return issues;
    } else if (fingerprint) {
      compiledSchemaOk.set(schemaPath, {
        compiledAt: Date.now(),
        mtimeMs: fingerprint.mtimeMs,
        size: fingerprint.size,
      });
    }
  }

  // ── Probe 3: config file parses ───────────────────────────────────────
  const configTargets: Array<{ path: string; label: 'repo' | 'local' | 'global' }> = [
    { path: resolve(repoDir, '.wavemill-config.json'), label: 'repo' },
    { path: resolve(repoDir, '.wavemill-config.local.json'), label: 'local' },
    { path: resolve(homeDir, '.wavemill', 'config.json'), label: 'global' },
  ];

  let sawConfigParseFailure = false;
  for (const target of configTargets) {
    if (!existsSync(target.path)) continue;
    let content: string;
    try {
      content = readFileSync(target.path, 'utf-8');
    } catch (err) {
      issues.push({
        file: target.path,
        kind: 'config-parse',
        message: `Failed to read config: ${errorMessage(err)}`,
      });
      sawConfigParseFailure = true;
      continue;
    }
    try {
      JSON.parse(content);
    } catch (err) {
      issues.push(buildParseIssue(target.path, 'config-parse', content, err));
      sawConfigParseFailure = true;
    }
  }

  if (sawConfigParseFailure) {
    // Skip the merged-validation probe: the loader would just re-report the
    // same parse failure, less informatively.
    return issues;
  }

  // ── Probe 4: merged validation ────────────────────────────────────────
  // Use the real production loader so schema validation, ready-policy subset
  // checks, and agents-model selector checks are all exercised. The cache
  // clear is deliberate: this observer probe must see the current on-disk
  // state each tick, not a stale value from an earlier successful load.
  try {
    clearConfigCache(repoDir);
    loadWavemillConfig(repoDir);
  } catch (err) {
    issues.push({
      file: resolve(repoDir, '.wavemill-config.json'),
      kind: 'config-validate',
      message: errorMessage(err),
    });
  }

  return issues;
}

/**
 * Reset the compile cache. Tests only — long-running processes get automatic
 * invalidation from the mtime/size fingerprint check.
 */
export function clearConfigIntegrityCache(): void {
  compiledSchemaOk.clear();
  didWarnAjvMissing = false;
}

// ─────────────────────────────────────────────────────────────────────────
// Internal helpers
// ─────────────────────────────────────────────────────────────────────────

/**
 * Resolve the schema path exactly as `getValidator` in config.ts does:
 * worktree schema (`<repoDir>/wavemill-config.schema.json`) if present, else
 * the canonical schema next to `shared/lib/`.
 */
function resolveSchemaPath(repoDir: string): string {
  const worktreeSchemaPath = resolve(repoDir, 'wavemill-config.schema.json');
  if (existsSync(worktreeSchemaPath)) {
    return worktreeSchemaPath;
  }
  // `shared/lib/config-integrity.ts` → repo root → schema. Use fileURLToPath so
  // this is robust under both file:// URLs and absolute paths.
  const here = fileURLToPath(import.meta.url);
  const canonical = resolve(dirname(here), '..', '..', 'wavemill-config.schema.json');
  return canonical;
}

function statFingerprint(path: string): { mtimeMs: number; size: number } | null {
  try {
    const st = statSync(path);
    return { mtimeMs: st.mtimeMs, size: st.size };
  } catch {
    return null;
  }
}

/**
 * Try to Ajv-compile a schema. Returns:
 *  - `null` on success
 *  - `'ajv-missing'` when ajv is not installed (matches config.ts behavior)
 *  - `Error` when compilation itself failed
 */
function tryAjvCompile(schema: unknown): null | 'ajv-missing' | Error {
  let AjvCtor: {
    new (options: { allErrors: boolean; strict: boolean }): { compile(schema: unknown): unknown };
  };
  try {
    const req = createRequire(import.meta.url);
    const ajvModule = req('ajv');
    AjvCtor = (ajvModule.default || ajvModule) as typeof AjvCtor;
  } catch (err) {
    const code = (err as { code?: string }).code;
    const message = errorMessage(err);
    if (
      code === 'MODULE_NOT_FOUND' ||
      code === 'ERR_MODULE_NOT_FOUND' ||
      /Cannot find package 'ajv'/.test(message) ||
      /Cannot find module 'ajv'/.test(message)
    ) {
      if (!didWarnAjvMissing) {
        didWarnAjvMissing = true;
        // eslint-disable-next-line no-console
        console.warn(`config-integrity: ajv unavailable (${message}); skipping schema-compile probe`);
      }
      return 'ajv-missing';
    }
    return err instanceof Error ? err : new Error(String(err));
  }

  try {
    const ajv = new AjvCtor({ allErrors: true, strict: false });
    ajv.compile(schema);
    return null;
  } catch (err) {
    return err instanceof Error ? err : new Error(String(err));
  }
}

/**
 * Build an integrity issue from a `JSON.parse` failure. Extracts the byte
 * offset from the V8 error message and computes 1-based line/column against
 * the actual file content — we do not rely on the `(line L column C)` suffix
 * that Node prints, since it has changed shape across releases.
 */
function buildParseIssue(
  filePath: string,
  kind: 'schema-parse' | 'config-parse',
  content: string,
  err: unknown,
): ConfigIntegrityIssue {
  const message = errorMessage(err);
  const position = extractPositionFromError(message);
  const issue: ConfigIntegrityIssue = {
    file: filePath,
    kind,
    message,
  };
  if (position !== null) {
    const clamped = Math.max(0, Math.min(position, content.length));
    issue.position = clamped;
    const { line, column } = computeLineColumn(content, clamped);
    issue.line = line;
    issue.column = column;
    issue.excerpt = buildExcerpt(content, clamped);
  }
  return issue;
}

/**
 * Extract a 0-based character offset from a V8/JavaScriptCore JSON error
 * message. Handles both:
 *   "Unexpected non-whitespace character after JSON at position 141378 (line 2903 column 6)"
 *   "Unexpected token } in JSON at position 42"
 * Returns `null` if no position is present.
 */
export function extractPositionFromError(message: string): number | null {
  const match = /\bposition\s+(\d+)\b/.exec(message);
  if (!match) return null;
  const parsed = Number.parseInt(match[1], 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

/**
 * Compute 1-based `line`/`column` for a byte offset by scanning the content.
 * `\n` bumps the line; `\r\n` is treated as a single line break so column
 * numbers line up with what an editor would show.
 */
export function computeLineColumn(content: string, position: number): { line: number; column: number } {
  let line = 1;
  let column = 1;
  const bound = Math.min(position, content.length);
  for (let i = 0; i < bound; i += 1) {
    const ch = content.charCodeAt(i);
    if (ch === 0x0a /* \n */) {
      line += 1;
      column = 1;
    } else if (ch === 0x0d /* \r */) {
      // Treat \r\n as one line break; a bare \r also advances the line.
      line += 1;
      column = 1;
      if (i + 1 < bound && content.charCodeAt(i + 1) === 0x0a) {
        i += 1;
      }
    } else {
      column += 1;
    }
  }
  return { line, column };
}

/**
 * Extract a compact single-line excerpt around `position` — up to 30 chars
 * before and 30 after, with newlines/tabs collapsed so it fits on one log
 * line. Empty string if content is empty.
 */
export function buildExcerpt(content: string, position: number): string {
  if (content.length === 0) return '';
  const start = Math.max(0, position - 30);
  const end = Math.min(content.length, position + 30);
  const slice = content.slice(start, end);
  return slice.replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
}
