/**
 * Shared Python AST helpers for migration ready-stage checks.
 *
 * The accompanying ``migration_ast.py`` script is invoked as a subprocess to
 * parse migration files via Python's ``ast`` module. Output is a structured
 * JSON document the consumers in this file convert to typed TypeScript
 * structures.
 *
 * The helper is shared between the migration reversibility check and the
 * forthcoming forbidden-DDL check so both can rely on the same stable parsed
 * representation. Both checks consume read-only data: the Python script never
 * executes the migration source, and this module never mutates input files.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execShellCommand, escapeShellArg } from './shell-utils.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PYTHON_SCRIPT_PATH = path.join(__dirname, 'migration_ast.py');

/**
 * Statement kinds emitted by ``migration_ast.py``.
 *
 * Most statements get a coarse-grained classification because the consumers
 * only need to distinguish a handful of shapes (docstring, ``pass``, ``raise``,
 * call expressions). The catch-all ``Other`` covers anything the Python helper
 * does not single out, which is sufficient for ``classifyDowngradeBody`` to
 * treat the body as ``non-trivial``.
 */
export type ParsedStatementType =
  | 'Pass'
  | 'Docstring'
  | 'Raise'
  | 'ExprCall'
  | 'Expr'
  | string;

export interface ParsedAttributeCall {
  type: 'AttributeCall';
  objectName: string | null;
  attrName: string;
}

export interface ParsedNameCall {
  type: 'NameCall';
  name: string;
}

export interface ParsedOtherCall {
  type: 'OtherCall';
}

export type ParsedCall = ParsedAttributeCall | ParsedNameCall | ParsedOtherCall;

export interface ParsedRaiseStatement {
  type: 'Raise';
  exceptionName: string | null;
  isCall: boolean;
}

export interface ParsedExprCallStatement {
  type: 'ExprCall';
  call: ParsedCall;
}

export interface ParsedSimpleStatement {
  type: Exclude<ParsedStatementType, 'Raise' | 'ExprCall'>;
}

export type ParsedStatement =
  | ParsedRaiseStatement
  | ParsedExprCallStatement
  | ParsedSimpleStatement;

export interface ParsedAttributeCallReference {
  objectName: string;
  attrName: string;
}

export interface ParsedFunction {
  name: string;
  isAsync: boolean;
  body: ParsedStatement[];
  /** All attribute-style calls anywhere in the function body. */
  attributeCalls: ParsedAttributeCallReference[];
}

export type MigrationParseErrorKind =
  | 'missing-argument'
  | 'file-not-found'
  | 'io-error'
  | 'syntax-error'
  | 'python-not-available'
  | 'invalid-output';

export interface MigrationParseError {
  kind: MigrationParseErrorKind;
  message: string;
}

export interface ParsedMigrationFile {
  filePath: string;
  functions: ParsedFunction[];
  parseError: MigrationParseError | null;
}

/**
 * Classification of a ``downgrade()`` function body for reversibility checks.
 *
 * - ``missing``: the function does not exist in the module.
 * - ``empty-pass``: only ``pass`` (with or without a leading docstring).
 * - ``empty-docstring``: only a docstring.
 * - ``not-implemented``: only ``raise NotImplementedError`` (bare or called),
 *   optionally with a leading docstring.
 * - ``non-trivial``: any other body shape.
 */
export type DowngradeClassification =
  | 'missing'
  | 'empty-pass'
  | 'empty-docstring'
  | 'not-implemented'
  | 'non-trivial';

/** Injectable shell hook so tests can stub Python invocation. */
export const migrationAstDeps = {
  execShellCommand,
};

/**
 * Parse a migration file with the Python ``ast`` module.
 *
 * Always resolves with a structured result. Failures (missing python3, syntax
 * errors, missing files, malformed output) are encoded in ``parseError`` so
 * callers can surface them as ready-check failures rather than throwing
 * unhandled exceptions.
 */
export function parseMigrationFile(
  filePath: string,
  options: { cwd?: string } = {},
): ParsedMigrationFile {
  const command = `python3 ${escapeShellArg(PYTHON_SCRIPT_PATH)} ${escapeShellArg(filePath)}`;
  let rawOutput: string;
  try {
    const result = migrationAstDeps.execShellCommand(command, {
      encoding: 'utf-8',
      cwd: options.cwd,
    });
    rawOutput = typeof result === 'string' ? result : result.toString('utf-8');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/python3: command not found|No such file or directory/i.test(message)) {
      return {
        filePath,
        functions: [],
        parseError: {
          kind: 'python-not-available',
          message: `python3 is required for migration AST parsing: ${message}`,
        },
      };
    }
    return {
      filePath,
      functions: [],
      parseError: {
        kind: 'io-error',
        message,
      },
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawOutput);
  } catch (error) {
    return {
      filePath,
      functions: [],
      parseError: {
        kind: 'invalid-output',
        message: `Failed to parse migration_ast.py output as JSON: ${
          error instanceof Error ? error.message : String(error)
        }`,
      },
    };
  }

  if (!isRecord(parsed)) {
    return {
      filePath,
      functions: [],
      parseError: {
        kind: 'invalid-output',
        message: 'migration_ast.py output was not a JSON object',
      },
    };
  }

  if (isRecord(parsed.parseError)) {
    return {
      filePath,
      functions: [],
      parseError: {
        kind: (parsed.parseError.kind as MigrationParseErrorKind) ?? 'invalid-output',
        message: typeof parsed.parseError.message === 'string'
          ? parsed.parseError.message
          : 'Unknown parse error',
      },
    };
  }

  const functions = Array.isArray(parsed.functions)
    ? parsed.functions.filter(isRecord).map(toParsedFunction)
    : [];

  return {
    filePath,
    functions,
    parseError: null,
  };
}

/** Look up a top-level function by name in a parsed migration file. */
export function getMigrationFunction(
  parsed: ParsedMigrationFile,
  name: 'upgrade' | 'downgrade' | string,
): ParsedFunction | undefined {
  return parsed.functions.find(fn => fn.name === name);
}

/**
 * Classify a downgrade-shaped function body for reversibility purposes.
 *
 * Only the leading docstring is stripped; this preserves the distinction
 * between ``pass`` and a ``raise NotImplementedError`` body, both of which
 * count as failure modes but with different operator-facing reasons.
 */
export function classifyDowngradeBody(
  body: ParsedStatement[] | undefined,
): DowngradeClassification {
  if (!body) {
    return 'missing';
  }

  let hasDocstring = false;
  let remaining = body;
  if (body[0]?.type === 'Docstring') {
    hasDocstring = true;
    remaining = body.slice(1);
  }

  if (remaining.length === 0) {
    return hasDocstring ? 'empty-docstring' : 'empty-pass';
  }

  if (remaining.length === 1) {
    const only = remaining[0];
    if (only.type === 'Pass') {
      return 'empty-pass';
    }
    if (only.type === 'Raise' && (only as ParsedRaiseStatement).exceptionName === 'NotImplementedError') {
      return 'not-implemented';
    }
  }

  return 'non-trivial';
}

/**
 * Return all attribute calls of the form ``<objectName>.<method>`` made inside
 * the function body, formatted as ``"object.method"`` strings.
 *
 * Calls nested inside conditionals or helper expressions are included; this is
 * the data the destructive-upgrade soft warning relies on to detect
 * ``op.drop_table`` / ``op.drop_column`` regardless of control flow.
 */
export function extractOperationCalls(
  fn: ParsedFunction | undefined,
  objectName: string = 'op',
): string[] {
  if (!fn) {
    return [];
  }
  return fn.attributeCalls
    .filter(call => call.objectName === objectName)
    .map(call => `${call.objectName}.${call.attrName}`);
}

// ───────────────────────────────────────────────
// Internal helpers
// ───────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toParsedFunction(raw: Record<string, unknown>): ParsedFunction {
  const name = typeof raw.name === 'string' ? raw.name : '';
  const isAsync = raw.isAsync === true;
  const body = Array.isArray(raw.body)
    ? raw.body.filter(isRecord).map(toParsedStatement)
    : [];
  const attributeCalls = Array.isArray(raw.attributeCalls)
    ? raw.attributeCalls
        .filter(isRecord)
        .map(toAttributeCallReference)
        .filter((entry): entry is ParsedAttributeCallReference => entry !== null)
    : [];
  return { name, isAsync, body, attributeCalls };
}

function toParsedStatement(raw: Record<string, unknown>): ParsedStatement {
  const type = typeof raw.type === 'string' ? raw.type : 'Other';
  if (type === 'Raise') {
    return {
      type: 'Raise',
      exceptionName: typeof raw.exceptionName === 'string' ? raw.exceptionName : null,
      isCall: raw.isCall === true,
    };
  }
  if (type === 'ExprCall') {
    return {
      type: 'ExprCall',
      call: isRecord(raw.call) ? toParsedCall(raw.call) : { type: 'OtherCall' },
    };
  }
  return { type };
}

function toParsedCall(raw: Record<string, unknown>): ParsedCall {
  const callType = typeof raw.type === 'string' ? raw.type : 'OtherCall';
  if (callType === 'AttributeCall') {
    return {
      type: 'AttributeCall',
      objectName: typeof raw.objectName === 'string' ? raw.objectName : null,
      attrName: typeof raw.attrName === 'string' ? raw.attrName : '',
    };
  }
  if (callType === 'NameCall') {
    return {
      type: 'NameCall',
      name: typeof raw.name === 'string' ? raw.name : '',
    };
  }
  return { type: 'OtherCall' };
}

function toAttributeCallReference(raw: Record<string, unknown>): ParsedAttributeCallReference | null {
  const objectName = typeof raw.objectName === 'string' ? raw.objectName : null;
  const attrName = typeof raw.attrName === 'string' ? raw.attrName : null;
  if (!objectName || !attrName) {
    return null;
  }
  return { objectName, attrName };
}
