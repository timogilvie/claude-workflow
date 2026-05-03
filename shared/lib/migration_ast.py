"""Parse a Python migration file and emit a structured AST summary as JSON.

This helper is intended for ready-stage migration checks (reversibility,
forbidden DDL, etc.). It is read-only: it parses but never executes the
migration source. Output is consumed by ``shared/lib/migration-ast.ts``.

Usage:
    python3 migration_ast.py <path-to-migration.py>

Output:
    A single JSON object on stdout with keys:
      - ``functions``: list of module-level function descriptors when parsing
        succeeds.
      - ``parseError``: ``{ "kind": ..., "message": ... }`` when parsing fails.

Exit code is always zero so the TypeScript caller can rely on stdout being a
JSON document for both success and parse-error cases.
"""

from __future__ import annotations

import ast
import json
import sys
from typing import Any


def _is_docstring(node: ast.stmt) -> bool:
    return (
        isinstance(node, ast.Expr)
        and isinstance(node.value, ast.Constant)
        and isinstance(node.value.value, str)
    )


def _serialize_call(call_node: ast.AST) -> dict[str, Any] | None:
    if not isinstance(call_node, ast.Call):
        return None
    func = call_node.func
    if isinstance(func, ast.Attribute):
        object_name: str | None = None
        if isinstance(func.value, ast.Name):
            object_name = func.value.id
        return {
            "type": "AttributeCall",
            "objectName": object_name,
            "attrName": func.attr,
        }
    if isinstance(func, ast.Name):
        return {"type": "NameCall", "name": func.id}
    return {"type": "OtherCall"}


def _serialize_statement(node: ast.stmt) -> dict[str, Any]:
    if isinstance(node, ast.Pass):
        return {"type": "Pass"}
    if _is_docstring(node):
        return {"type": "Docstring"}
    if isinstance(node, ast.Raise):
        exc = node.exc
        exception_name: str | None = None
        is_call = False
        if isinstance(exc, ast.Name):
            exception_name = exc.id
        elif isinstance(exc, ast.Call):
            is_call = True
            if isinstance(exc.func, ast.Name):
                exception_name = exc.func.id
            elif isinstance(exc.func, ast.Attribute):
                exception_name = exc.func.attr
        return {
            "type": "Raise",
            "exceptionName": exception_name,
            "isCall": is_call,
        }
    if isinstance(node, ast.Expr):
        call = _serialize_call(node.value)
        if call is not None:
            return {"type": "ExprCall", "call": call}
        return {"type": "Expr"}
    return {"type": type(node).__name__}


def _collect_attribute_calls(body: list[ast.stmt]) -> list[dict[str, str]]:
    """Recursively walk the function body and collect Attribute-style calls.

    Each entry is ``{"objectName": <id>, "attrName": <name>}``. Nested calls
    inside conditionals or loops are included so destructive ``op.drop_*``
    calls cannot hide behind ``if`` blocks.
    """

    calls: list[dict[str, str]] = []
    for stmt in body:
        for child in ast.walk(stmt):
            if not isinstance(child, ast.Call):
                continue
            func = child.func
            if not isinstance(func, ast.Attribute):
                continue
            if not isinstance(func.value, ast.Name):
                continue
            calls.append({
                "objectName": func.value.id,
                "attrName": func.attr,
            })
    return calls


def _serialize_function(node: ast.FunctionDef | ast.AsyncFunctionDef) -> dict[str, Any]:
    return {
        "name": node.name,
        "isAsync": isinstance(node, ast.AsyncFunctionDef),
        "body": [_serialize_statement(stmt) for stmt in node.body],
        "attributeCalls": _collect_attribute_calls(node.body),
    }


def main(argv: list[str]) -> int:
    if len(argv) < 2:
        json.dump(
            {"parseError": {"kind": "missing-argument", "message": "expected file path"}},
            sys.stdout,
        )
        return 0

    file_path = argv[1]
    try:
        with open(file_path, "r", encoding="utf-8") as fh:
            source = fh.read()
    except FileNotFoundError:
        json.dump(
            {"parseError": {"kind": "file-not-found", "message": file_path}},
            sys.stdout,
        )
        return 0
    except OSError as exc:
        json.dump(
            {"parseError": {"kind": "io-error", "message": str(exc)}},
            sys.stdout,
        )
        return 0

    try:
        tree = ast.parse(source, filename=file_path)
    except SyntaxError as exc:
        json.dump(
            {"parseError": {"kind": "syntax-error", "message": str(exc)}},
            sys.stdout,
        )
        return 0

    functions: list[dict[str, Any]] = []
    for node in tree.body:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            functions.append(_serialize_function(node))

    json.dump({"functions": functions}, sys.stdout)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
