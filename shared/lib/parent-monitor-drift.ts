export type FunctionSide = 'parent' | 'monitor';

export interface ShellFunction {
  name: string;
  side: FunctionSide;
  startLine: number;
  endLine: number;
  bodyText: string;
}

export interface DivergentEntry {
  name: string;
  parent: ShellFunction;
  monitor: ShellFunction;
  diff: string;
}

export interface DriftReport {
  duplicated: string[];
  identical: string[];
  divergent: DivergentEntry[];
}

interface Heredoc {
  tag: string;
  allowLeadingTabs: boolean;
}

const FUNCTION_START_PATTERNS = [
  /^([A-Za-z_][A-Za-z0-9_]*)\(\)[ \t]*\{[ \t]*$/,
  /^function[ \t]+([A-Za-z_][A-Za-z0-9_]*)(?:\(\))?[ \t]*\{[ \t]*$/,
];

const SIDE_PATHS: Record<FunctionSide, string> = {
  parent: 'shared/lib/wavemill-mill.sh',
  monitor: 'shared/lib/wavemill-monitor.sh',
};

export class ParentMonitorDriftError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ParentMonitorDriftError';
  }
}

function splitLines(text: string): string[] {
  if (text.length === 0) return [];
  return text.split(/(?<=\n)/);
}

function lineWithoutNewline(line: string): string {
  return line.replace(/\r?\n$/, '');
}

function parseHeredocOpener(line: string): Heredoc[] {
  const heredocs: Heredoc[] = [];
  const heredocPattern = /(?<!<)(<<-?)(?!<)[ \t]*(?:'([A-Za-z_][A-Za-z0-9_]*)'|"([A-Za-z_][A-Za-z0-9_]*)"|([A-Za-z_][A-Za-z0-9_]*))/g;

  for (const match of line.matchAll(heredocPattern)) {
    const tag = match[2] ?? match[3] ?? match[4];
    if (tag) heredocs.push({ tag, allowLeadingTabs: match[1] === '<<-' });
  }

  return heredocs;
}

function isHeredocTerminator(line: string, heredoc: Heredoc): boolean {
  const candidate = lineWithoutNewline(line);
  return heredoc.allowLeadingTabs
    ? candidate.replace(/^\t+/, '') === heredoc.tag
    : candidate === heredoc.tag;
}

function findFunctionStart(line: string): string | null {
  const normalized = lineWithoutNewline(line);
  for (const pattern of FUNCTION_START_PATTERNS) {
    const match = pattern.exec(normalized);
    if (match?.[1]) return match[1];
  }
  return null;
}

function countBraceDelta(line: string): number {
  let delta = 0;
  let singleQuoted = false;
  let doubleQuoted = false;
  let escaped = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]!;

    if (escaped) {
      escaped = false;
      continue;
    }

    if (char === '\\') {
      if (!singleQuoted) escaped = true;
      continue;
    }

    if (char === "'" && !doubleQuoted) {
      singleQuoted = !singleQuoted;
      continue;
    }

    if (char === '"' && !singleQuoted) {
      doubleQuoted = !doubleQuoted;
      continue;
    }

    if (
      char === '#'
      && !singleQuoted
      && !doubleQuoted
      && (index === 0 || /\s/.test(line[index - 1]!))
    ) {
      break;
    }

    if (!singleQuoted && !doubleQuoted) {
      if (char === '{') delta += 1;
      if (char === '}') delta -= 1;
    }
  }

  return delta;
}

function renderLineDiff(parent: ShellFunction, monitor: ShellFunction): string {
  const parentLines = splitLines(parent.bodyText);
  const monitorLines = splitLines(monitor.bodyText);
  const output = [
    `--- parent ${parent.name} (${formatFunctionLocation(parent)})`,
    `+++ monitor ${monitor.name} (${formatFunctionLocation(monitor)})`,
    '@@ line-by-line diff @@',
  ];
  const maximum = Math.max(parentLines.length, monitorLines.length);

  for (let index = 0; index < maximum && output.length < 80; index += 1) {
    if (parentLines[index] === monitorLines[index]) continue;
    if (parentLines[index] !== undefined) output.push(`-${lineWithoutNewline(parentLines[index]!)}`);
    if (monitorLines[index] !== undefined) output.push(`+${lineWithoutNewline(monitorLines[index]!)}`);
  }

  if (output.length === 80) output.push('... diff truncated ...');
  return output.join('\n');
}

export function formatFunctionLocation(fn: ShellFunction): string {
  return `${SIDE_PATHS[fn.side]}:${fn.startLine}-${fn.endLine}`;
}

function extractFunctionsFromRange(
  lines: readonly string[],
  startIndex: number,
  endIndex: number,
  side: FunctionSide,
): ShellFunction[] {
  const functions: ShellFunction[] = [];
  let current: { name: string; startIndex: number; braceDepth: number; pendingHeredocs: Heredoc[] } | null = null;
  const activeHeredocs: Heredoc[] = [];

  for (let index = startIndex; index < endIndex; index += 1) {
    const line = lines[index]!;

    if (activeHeredocs.length > 0) {
      if (isHeredocTerminator(line, activeHeredocs[0]!)) activeHeredocs.shift();
      continue;
    }

    if (!current) {
      const name = findFunctionStart(line);
      if (!name) continue;

      current = {
        name,
        startIndex: index,
        braceDepth: countBraceDelta(line),
        pendingHeredocs: parseHeredocOpener(line),
      };

      if (current.pendingHeredocs.length > 0) activeHeredocs.push(...current.pendingHeredocs.splice(0));
      if (current.braceDepth === 0) {
        functions.push({
          name: current.name,
          side,
          startLine: current.startIndex + 1,
          endLine: index + 1,
          bodyText: lines.slice(current.startIndex, index + 1).join(''),
        });
        current = null;
      }
      continue;
    }

    current.braceDepth += countBraceDelta(line);
    current.pendingHeredocs = parseHeredocOpener(line);
    if (current.pendingHeredocs.length > 0) activeHeredocs.push(...current.pendingHeredocs.splice(0));

    if (current.braceDepth === 0) {
      functions.push({
        name: current.name,
        side,
        startLine: current.startIndex + 1,
        endLine: index + 1,
        bodyText: lines.slice(current.startIndex, index + 1).join(''),
      });
      current = null;
    }
  }

  if (activeHeredocs.length > 0) {
    throw new ParentMonitorDriftError(`Unterminated heredoc ${activeHeredocs[0]!.tag} in ${side} partition.`);
  }
  if (current) {
    throw new ParentMonitorDriftError(`Unterminated function ${current.name} in ${side} partition.`);
  }

  return functions;
}

export function extractTopLevelFunctions(scriptText: string, side: FunctionSide): ShellFunction[] {
  const lines = splitLines(scriptText);
  return extractFunctionsFromRange(lines, 0, lines.length, side);
}

export function compareParentMonitorFiles(parentText: string, monitorText: string): DriftReport {
  const functions = [
    ...extractTopLevelFunctions(parentText, 'parent'),
    ...extractTopLevelFunctions(monitorText, 'monitor'),
  ];
  const byName = new Map<string, Partial<Record<FunctionSide, ShellFunction>>>();

  for (const fn of functions) {
    const pair = byName.get(fn.name) ?? {};
    pair[fn.side] = fn;
    byName.set(fn.name, pair);
  }

  const duplicated: string[] = [];
  const identical: string[] = [];
  const divergent: DivergentEntry[] = [];

  for (const [name, pair] of byName) {
    if (!pair.parent || !pair.monitor) continue;
    duplicated.push(name);
    if (pair.parent.bodyText === pair.monitor.bodyText) {
      identical.push(name);
    } else {
      divergent.push({
        name,
        parent: pair.parent,
        monitor: pair.monitor,
        diff: renderLineDiff(pair.parent, pair.monitor),
      });
    }
  }

  duplicated.sort();
  identical.sort();
  divergent.sort((a, b) => a.name.localeCompare(b.name));

  return { duplicated, identical, divergent };
}

export function formatDriftReport(report: DriftReport): string {
  const lines = [
    `Duplicated parent/monitor functions: ${report.duplicated.length}`,
    `Byte-identical functions: ${report.identical.length}`,
    `Divergent functions: ${report.divergent.length}`,
  ];

  for (const entry of report.divergent) {
    lines.push(
      '',
      `DIVERGENT: ${entry.name} parent:${entry.parent.startLine}-${entry.parent.endLine} monitor:${entry.monitor.startLine}-${entry.monitor.endLine}`,
      entry.diff,
    );
  }

  return lines.join('\n');
}
