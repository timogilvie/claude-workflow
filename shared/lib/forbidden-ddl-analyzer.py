#!/usr/bin/env python3

from __future__ import annotations

import ast
import json
import re
import sys
from pathlib import Path


DML_PATTERN = re.compile(r"\b(UPDATE|INSERT|DELETE)\b", re.IGNORECASE)
SQL_DML_STATEMENT_PATTERN = re.compile(r"^\s*(UPDATE|INSERT|DELETE)\b", re.IGNORECASE)
SQL_DROP_TABLE_PATTERN = re.compile(r"\bDROP\s+TABLE\b", re.IGNORECASE)
SQL_DROP_COLUMN_PATTERN = re.compile(r"\bDROP\s+COLUMN\b", re.IGNORECASE)
SQL_ALTER_COLUMN_TYPE_PATTERN = re.compile(
    r"\bALTER\s+(?:COLUMN\s+)?[A-Za-z_][\w\"]*\s+TYPE\b",
    re.IGNORECASE,
)


def literal_false(node: ast.AST) -> bool:
    return isinstance(node, ast.Constant) and node.value is False


def literal_none(node: ast.AST) -> bool:
    return isinstance(node, ast.Constant) and node.value is None


def literal_string(node: ast.AST) -> str | None:
    if isinstance(node, ast.Constant) and isinstance(node.value, str):
        return node.value
    return None


def unparse(node: ast.AST) -> str:
    if hasattr(ast, "unparse"):
        return ast.unparse(node)
    return node.__class__.__name__


def op_call_name(node: ast.Call) -> str | None:
    func = node.func
    if isinstance(func, ast.Attribute) and isinstance(func.value, ast.Name) and func.value.id == "op":
        return func.attr
    return None


def keyword_map(node: ast.Call) -> dict[str, ast.AST]:
    return {
        keyword.arg: keyword.value
        for keyword in node.keywords
        if keyword.arg is not None
    }


def analyze_add_column(node: ast.Call) -> list[dict[str, object]]:
    if len(node.args) < 2 or not isinstance(node.args[1], ast.Call):
        return []

    column_call = node.args[1]
    if not isinstance(column_call.func, ast.Attribute):
        return []
    if not isinstance(column_call.func.value, ast.Name):
        return []
    if column_call.func.value.id not in {"sa", "sqlalchemy"} or column_call.func.attr != "Column":
        return []

    column_keywords = keyword_map(column_call)
    nullable = column_keywords.get("nullable")
    server_default = column_keywords.get("server_default")
    if literal_false(nullable) and (server_default is None or literal_none(server_default)):
        return [{
            "line": node.lineno,
            "rule": "add_column_non_nullable_no_default",
            "detail": unparse(node),
        }]

    return []


def analyze_alter_column(node: ast.Call) -> list[dict[str, object]]:
    if "type_" not in keyword_map(node):
        return []
    return [{
        "line": node.lineno,
        "rule": "alter_column_type",
        "detail": unparse(node),
    }]


def analyze_execute(node: ast.Call) -> list[dict[str, object]]:
    if not node.args:
        return []

    sql = literal_string(node.args[0])
    if sql is None or not DML_PATTERN.search(sql):
        return []

    return [{
        "line": node.lineno,
        "rule": "execute_dml",
        "detail": sql.strip(),
    }]


def analyze_call(node: ast.Call) -> list[dict[str, object]]:
    op_name = op_call_name(node)
    if op_name == "add_column":
        return analyze_add_column(node)
    if op_name == "drop_column":
        return [{
            "line": node.lineno,
            "rule": "drop_column",
            "detail": unparse(node),
        }]
    if op_name == "drop_table":
        return [{
            "line": node.lineno,
            "rule": "drop_table",
            "detail": unparse(node),
        }]
    if op_name == "alter_column":
        return analyze_alter_column(node)
    if op_name == "execute":
        return analyze_execute(node)
    return []


def analyze_upgrade(tree: ast.AST) -> list[dict[str, object]]:
    for node in tree.body:
        if isinstance(node, ast.FunctionDef) and node.name == "upgrade":
            # Only direct AST under upgrade() is inspected; helper calls are out of scope.
            findings: list[dict[str, object]] = []
            for child in ast.walk(node):
                if isinstance(child, ast.Call):
                    findings.extend(analyze_call(child))
            return findings
    return []


def analyze_file(filename: str) -> tuple[list[dict[str, object]], list[dict[str, str]]]:
    file_path = Path(filename)
    try:
        source = file_path.read_text(encoding="utf-8")
    except OSError as error:
        return [], [{"file": str(file_path), "message": str(error)}]

    if file_path.suffix.lower() == ".sql":
        findings = [
            {"file": str(file_path), **finding}
            for finding in analyze_sql(source)
        ]
        return findings, []

    try:
        tree = ast.parse(source, filename=str(file_path))
    except SyntaxError as error:
        return [], [{
            "file": str(file_path),
            "message": f"SyntaxError: {error.msg} (line {error.lineno})",
        }]

    findings = [
        {"file": str(file_path), **finding}
        for finding in analyze_upgrade(tree)
    ]
    return findings, []


def analyze_sql(source: str) -> list[dict[str, object]]:
    findings: list[dict[str, object]] = []

    for line_number, line in enumerate(source.splitlines(), start=1):
        stripped = line.strip()
        if not stripped or stripped.startswith("--"):
            continue
        if SQL_DROP_TABLE_PATTERN.search(stripped):
            findings.append({
                "line": line_number,
                "rule": "drop_table",
                "detail": stripped,
            })
        if SQL_DROP_COLUMN_PATTERN.search(stripped):
            findings.append({
                "line": line_number,
                "rule": "drop_column",
                "detail": stripped,
            })
        if SQL_ALTER_COLUMN_TYPE_PATTERN.search(stripped):
            findings.append({
                "line": line_number,
                "rule": "alter_column_type",
                "detail": stripped,
            })
        if SQL_DML_STATEMENT_PATTERN.search(stripped):
            findings.append({
                "line": line_number,
                "rule": "execute_dml",
                "detail": stripped,
            })

    return findings


def main(argv: list[str]) -> int:
    findings: list[dict[str, object]] = []
    errors: list[dict[str, str]] = []

    for filename in argv[1:]:
        file_findings, file_errors = analyze_file(filename)
        findings.extend(file_findings)
        errors.extend(file_errors)

    print(json.dumps({"findings": findings, "errors": errors}))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
