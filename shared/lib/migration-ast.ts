import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export type MigrationStatementKind =
  | 'docstring'
  | 'pass'
  | 'raise-not-implemented'
  | 'op-call'
  | 'other';

export interface MigrationOpCall {
  functionName: string;
  location?: { line: number; column: number };
}

export interface MigrationFunctionAst {
  name: 'upgrade' | 'downgrade';
  statements: MigrationStatementKind[];
  opCalls: MigrationOpCall[];
}

export interface ParsedMigrationFile {
  filePath: string;
  upgrade: MigrationFunctionAst;
  downgrade: MigrationFunctionAst;
}

const PYTHON_AST_SCRIPT = `
import ast
import json
import sys

file_path = sys.argv[1]

try:
    with open(file_path, "r", encoding="utf-8") as handle:
        source = handle.read()
    tree = ast.parse(source, filename=file_path)
except (OSError, SyntaxError):
    print("null")
    raise SystemExit(0)

functions = {}

def is_docstring(node):
    value = getattr(node, "value", None)
    if not isinstance(node, ast.Expr):
        return False
    if isinstance(value, ast.Constant):
        return isinstance(value.value, str)
    return isinstance(value, ast.Str)

def is_not_implemented(target):
    if isinstance(target, ast.Name):
        return target.id == "NotImplementedError"
    if isinstance(target, ast.Call) and isinstance(target.func, ast.Name):
        return target.func.id == "NotImplementedError"
    return False

def collect_op_calls(node):
    calls = []
    for child in ast.walk(node):
        if not isinstance(child, ast.Call):
            continue
        func = child.func
        if isinstance(func, ast.Attribute) and isinstance(func.value, ast.Name) and func.value.id == "op":
            calls.append({
                "functionName": func.attr,
                "location": {
                    "line": getattr(child, "lineno", None),
                    "column": getattr(child, "col_offset", None),
                },
            })
    return calls

def classify_statement(node):
    if is_docstring(node):
        return "docstring"
    if isinstance(node, ast.Pass):
        return "pass"
    if isinstance(node, ast.Raise) and is_not_implemented(node.exc):
        return "raise-not-implemented"
    if collect_op_calls(node):
        return "op-call"
    return "other"

def encode_function(node):
    return {
        "name": node.name,
        "statements": [classify_statement(stmt) for stmt in node.body],
        "opCalls": [
            call for stmt in node.body for call in collect_op_calls(stmt)
        ],
    }

def maybe_capture(node):
    if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name in ("upgrade", "downgrade"):
        functions.setdefault(node.name, encode_function(node))
    elif isinstance(node, ast.ClassDef):
        for child in node.body:
            if isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef)) and child.name in ("upgrade", "downgrade"):
                functions.setdefault(child.name, encode_function(child))

for node in tree.body:
    maybe_capture(node)

if "upgrade" not in functions or "downgrade" not in functions:
    print("null")
else:
    print(json.dumps({
        "filePath": file_path,
        "upgrade": functions["upgrade"],
        "downgrade": functions["downgrade"],
    }))
`;

function normalizeOpCall(opCall: Record<string, unknown>): MigrationOpCall {
  const line = typeof opCall.location === 'object' && opCall.location !== null &&
    typeof (opCall.location as Record<string, unknown>).line === 'number'
    ? (opCall.location as Record<string, number>).line
    : undefined;
  const column = typeof opCall.location === 'object' && opCall.location !== null &&
    typeof (opCall.location as Record<string, unknown>).column === 'number'
    ? (opCall.location as Record<string, number>).column
    : undefined;

  return {
    functionName: String(opCall.functionName),
    location: line === undefined || column === undefined ? undefined : { line, column },
  };
}

function normalizeFunctionAst(
  name: 'upgrade' | 'downgrade',
  value: Record<string, unknown>
): MigrationFunctionAst {
  const statements = Array.isArray(value.statements)
    ? value.statements.filter((statement): statement is MigrationStatementKind =>
      statement === 'docstring' ||
      statement === 'pass' ||
      statement === 'raise-not-implemented' ||
      statement === 'op-call' ||
      statement === 'other')
    : [];

  const opCalls = Array.isArray(value.opCalls)
    ? value.opCalls
        .filter((opCall): opCall is Record<string, unknown> =>
          typeof opCall === 'object' && opCall !== null && typeof opCall.functionName === 'string')
        .map(normalizeOpCall)
    : [];

  return { name, statements, opCalls };
}

function isParsedMigrationFile(value: unknown): value is {
  filePath: string;
  upgrade: Record<string, unknown>;
  downgrade: Record<string, unknown>;
} {
  return typeof value === 'object' &&
    value !== null &&
    typeof (value as Record<string, unknown>).filePath === 'string' &&
    typeof (value as Record<string, unknown>).upgrade === 'object' &&
    (value as Record<string, unknown>).upgrade !== null &&
    typeof (value as Record<string, unknown>).downgrade === 'object' &&
    (value as Record<string, unknown>).downgrade !== null;
}

export async function parseMigrationFile(filePath: string): Promise<ParsedMigrationFile | null> {
  const { stdout } = await execFileAsync('python3', ['-c', PYTHON_AST_SCRIPT, filePath], {
    encoding: 'utf-8',
  });

  const raw = stdout.trim();
  if (!raw || raw === 'null') {
    return null;
  }

  const parsed = JSON.parse(raw);
  if (!isParsedMigrationFile(parsed)) {
    return null;
  }

  return {
    filePath: parsed.filePath,
    upgrade: normalizeFunctionAst('upgrade', parsed.upgrade),
    downgrade: normalizeFunctionAst('downgrade', parsed.downgrade),
  };
}
