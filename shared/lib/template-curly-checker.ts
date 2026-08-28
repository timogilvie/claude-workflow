import { existsSync, readFileSync } from 'node:fs';
import path, { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as ts from 'typescript';

const __filename = fileURLToPath(import.meta.url);
const defaultRepoRoot = join(dirname(__filename), '..', '..');
const TEMPLATE_CURLY_PATTERN = /\$\{[^}]+\}/;
const SUPPRESSION_MARKER = 'allow-template-curly';
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);

export interface TemplateCurlyFinding {
  file: string;
  line: number;
  column: number;
  text: string;
}

export interface TemplateCurlyResult {
  ok: boolean;
  scannedFiles: number;
  findings: TemplateCurlyFinding[];
}

/**
 * Finds plain string literals that look like a missed template interpolation.
 */
export function checkSourceText(fileName: string, sourceText: string): TemplateCurlyFinding[] {
  const sourceFile = ts.createSourceFile(
    fileName,
    sourceText,
    ts.ScriptTarget.Latest,
    false,
    scriptKindForPath(fileName),
  );
  const lines = sourceText.split(/\r?\n/);
  const findings: TemplateCurlyFinding[] = [];

  function visit(node: ts.Node): void {
    if (ts.isStringLiteral(node) && TEMPLATE_CURLY_PATTERN.test(node.text)) {
      const start = node.getStart(sourceFile);
      const position = sourceFile.getLineAndCharacterOfPosition(start);
      const line = position.line + 1;
      if (!isSuppressed(lines, line)) {
        findings.push({
          file: normalizePath(fileName),
          line,
          column: position.character + 1,
          text: truncateLiteral(node.getText(sourceFile)),
        });
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return findings;
}

export function checkTemplateCurly(repoDir = defaultRepoRoot): TemplateCurlyResult {
  const files = listTrackedSourceFiles(repoDir);
  const findings: TemplateCurlyFinding[] = [];
  let scannedFiles = 0;

  for (const file of files) {
    const fullPath = join(repoDir, file);
    if (!existsSync(fullPath)) {
      continue;
    }

    const sourceText = readSourceFile(fullPath);
    scannedFiles += 1;
    if (sourceText === null || !sourceText.includes('${')) {
      continue;
    }

    findings.push(...checkSourceText(file, sourceText));
  }

  return {
    ok: findings.length === 0,
    scannedFiles,
    findings,
  };
}

function readSourceFile(filePath: string): string | null {
  try {
    return readFileSync(filePath, 'utf-8');
  } catch {
    return null;
  }
}

export function formatTemplateCurly(result: TemplateCurlyResult): string {
  if (result.ok) {
    return `template-curly: ok (${result.scannedFiles} files scanned)`;
  }

  const placeholderSyntax = '$' + '{...}';
  return [
    `template-curly: found ${result.findings.length} plain string literal(s) containing ${placeholderSyntax}:`,
    ...result.findings.map((finding, index) => (
      `${index + 1}. ${finding.file}:${finding.line}:${finding.column} ${finding.text}`
    )),
    '',
    'If interpolation was intended, switch the string to backticks.',
    `If the ${placeholderSyntax} text is literal on purpose, add a nearby comment:`,
    `// ${SUPPRESSION_MARKER}: <reason>`,
  ].join('\n');
}

function listTrackedSourceFiles(repoDir: string): string[] {
  const output = execFileSync(
    'git',
    ['ls-files', '-z', '--', '*.ts', '*.tsx', '*.js', '*.jsx', '*.mjs', '*.cjs'],
    { cwd: repoDir, encoding: 'utf-8' },
  );
  return output
    .split('\0')
    .filter(Boolean)
    .filter((file) => SOURCE_EXTENSIONS.has(path.extname(file)));
}

function isSuppressed(lines: string[], oneBasedLine: number): boolean {
  const currentLine = lines[oneBasedLine - 1] ?? '';
  const previousLine = lines[oneBasedLine - 2] ?? '';
  return currentLine.includes(SUPPRESSION_MARKER) || previousLine.includes(SUPPRESSION_MARKER);
}

function truncateLiteral(text: string): string {
  const normalized = text.replace(/\s+/g, ' ');
  if (normalized.length <= 120) {
    return normalized;
  }
  return `${normalized.slice(0, 117)}...`;
}

function scriptKindForPath(fileName: string): ts.ScriptKind {
  switch (path.extname(fileName)) {
    case '.tsx':
      return ts.ScriptKind.TSX;
    case '.jsx':
      return ts.ScriptKind.JSX;
    case '.js':
    case '.mjs':
    case '.cjs':
      return ts.ScriptKind.JS;
    default:
      return ts.ScriptKind.TS;
  }
}

function normalizePath(fileName: string): string {
  return fileName.split(path.sep).join(path.posix.sep);
}
