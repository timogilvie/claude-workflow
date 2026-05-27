#!/usr/bin/env -S npx tsx

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

type Severity = 'urgent' | 'high' | 'medium' | 'low';
type Category = 'stuck' | 'crash' | 'warning' | 'ux' | 'operational';
type Confidence = 'high' | 'medium' | 'low';

interface ObserverOptions {
  loop: boolean;
  once: boolean;
  json: boolean;
  intervalSeconds: number;
  staleMinutes: number;
  hungMinutes: number;
  fileLinear: boolean;
  dryRun: boolean;
  linearTeam?: string;
  linearProject?: string;
  linearLabel?: string;
  maxLogLines: number;
  printPrompt: boolean;
}

interface Pane {
  session: string;
  windowIndex: string;
  paneIndex: string;
  windowName: string;
  active: boolean;
  pid: number;
  command: string;
  title: string;
}

interface ProcessRow {
  pid: number;
  ppid: number;
  stat: string;
  elapsedSeconds: number;
  command: string;
}

interface TaskState {
  issue: string;
  slug?: string;
  phase?: string;
  status?: string;
  pr?: string;
  worktree?: string;
  updated?: string;
  agent?: string;
  challengeRole?: string;
}

interface Finding {
  id: string;
  severity: Severity;
  category: Category;
  confidence: Confidence;
  session?: string;
  repoDir?: string;
  issue?: string;
  title: string;
  evidence: string[];
  recommendation: string;
  linearIssueUrl?: string;
}

interface RepoSnapshot {
  session: string;
  repoDir: string;
  workflowStatePath?: string;
  millLogPath?: string;
  tasks: TaskState[];
  stateMtime?: string;
  logMtime?: string;
}

interface ObserverSnapshot {
  timestamp: string;
  sessions: string[];
  panes: Pane[];
  processes: ProcessRow[];
  repos: RepoSnapshot[];
  findings: Finding[];
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_INTERVAL_SECONDS = 120;
const DEFAULT_STALE_MINUTES = 10;
const DEFAULT_HUNG_MINUTES = 10;

function usage(): string {
  return `Wavemill Observer

Usage:
  wavemill observer [options]

Options:
  --once                 Run one observation pass and exit (default)
  --loop                 Watch continuously
  --interval <seconds>   Loop interval (default: ${DEFAULT_INTERVAL_SECONDS})
  --json                 Emit JSON snapshots
  --file-linear          Create Linear issues for high-confidence findings
  --linear-team <key>    Linear team key/name/id for filed issues
  --linear-project <id>  Optional Linear project id/name for filed issues
  --linear-label <name>  Optional Linear label name to attach
  --dry-run              Do not create Linear issues
  --stale-minutes <n>    State/log stale threshold (default: ${DEFAULT_STALE_MINUTES})
  --hung-minutes <n>     Child process hung threshold (default: ${DEFAULT_HUNG_MINUTES})
  --max-log-lines <n>    Recent mill log lines to inspect (default: 240)
  --print-prompt         Print the recommended long-running Codex prompt
  --help                 Show this help
`;
}

function parseArgs(argv: string[]): ObserverOptions {
  const options: ObserverOptions = {
    loop: false,
    once: true,
    json: false,
    intervalSeconds: DEFAULT_INTERVAL_SECONDS,
    staleMinutes: DEFAULT_STALE_MINUTES,
    hungMinutes: DEFAULT_HUNG_MINUTES,
    fileLinear: false,
    dryRun: false,
    maxLogLines: 240,
    printPrompt: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      const value = argv[i + 1];
      if (!value || value.startsWith('--')) {
        throw new Error(`${arg} requires a value`);
      }
      i += 1;
      return value;
    };

    if (arg === '--help' || arg === '-h') {
      process.stdout.write(usage());
      process.exit(0);
    } else if (arg === '--once') {
      options.once = true;
      options.loop = false;
    } else if (arg === '--loop') {
      options.loop = true;
      options.once = false;
    } else if (arg === '--json') {
      options.json = true;
    } else if (arg === '--file-linear') {
      options.fileLinear = true;
    } else if (arg === '--dry-run') {
      options.dryRun = true;
    } else if (arg === '--print-prompt') {
      options.printPrompt = true;
    } else if (arg === '--interval') {
      options.intervalSeconds = parsePositiveInt(next(), arg);
    } else if (arg.startsWith('--interval=')) {
      options.intervalSeconds = parsePositiveInt(arg.slice('--interval='.length), '--interval');
    } else if (arg === '--stale-minutes') {
      options.staleMinutes = parsePositiveInt(next(), arg);
    } else if (arg.startsWith('--stale-minutes=')) {
      options.staleMinutes = parsePositiveInt(arg.slice('--stale-minutes='.length), '--stale-minutes');
    } else if (arg === '--hung-minutes') {
      options.hungMinutes = parsePositiveInt(next(), arg);
    } else if (arg.startsWith('--hung-minutes=')) {
      options.hungMinutes = parsePositiveInt(arg.slice('--hung-minutes='.length), '--hung-minutes');
    } else if (arg === '--max-log-lines') {
      options.maxLogLines = parsePositiveInt(next(), arg);
    } else if (arg.startsWith('--max-log-lines=')) {
      options.maxLogLines = parsePositiveInt(arg.slice('--max-log-lines='.length), '--max-log-lines');
    } else if (arg === '--linear-team') {
      options.linearTeam = next();
    } else if (arg.startsWith('--linear-team=')) {
      options.linearTeam = arg.slice('--linear-team='.length);
    } else if (arg === '--linear-project') {
      options.linearProject = next();
    } else if (arg.startsWith('--linear-project=')) {
      options.linearProject = arg.slice('--linear-project='.length);
    } else if (arg === '--linear-label') {
      options.linearLabel = next();
    } else if (arg.startsWith('--linear-label=')) {
      options.linearLabel = arg.slice('--linear-label='.length);
    } else {
      throw new Error(`Unknown observer option: ${arg}`);
    }
  }

  return options;
}

function parsePositiveInt(value: string, flag: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${flag} must be a positive integer`);
  }
  return parsed;
}

function run(command: string, args: string[], timeoutMs = 10_000): { ok: boolean; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync(command, args, {
      encoding: 'utf8',
      timeout: timeoutMs,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { ok: true, stdout, stderr: '' };
  } catch (error: any) {
    return {
      ok: false,
      stdout: error.stdout?.toString() ?? '',
      stderr: error.stderr?.toString() ?? error.message ?? String(error),
    };
  }
}

function shell(command: string, timeoutMs = 10_000): { ok: boolean; stdout: string; stderr: string } {
  return run('/bin/bash', ['-lc', command], timeoutMs);
}

function parseElapsed(value: string): number {
  const parts = value.trim().split('-');
  let days = 0;
  let time = parts[0];
  if (parts.length === 2) {
    days = Number.parseInt(parts[0], 10) || 0;
    time = parts[1];
  }
  const nums = time.split(':').map((part) => Number.parseInt(part, 10) || 0);
  if (nums.length === 3) {
    return days * 86400 + nums[0] * 3600 + nums[1] * 60 + nums[2];
  }
  if (nums.length === 2) {
    return days * 86400 + nums[0] * 60 + nums[1];
  }
  return days * 86400 + (nums[0] || 0);
}

function listSessions(): string[] {
  const result = run('tmux', ['list-sessions', '-F', '#{session_name}'], 5_000);
  if (!result.ok) {
    return [];
  }
  return result.stdout.split('\n').map((line) => line.trim()).filter(Boolean);
}

function listPanes(): Pane[] {
  const format = [
    '#{session_name}',
    '#{window_index}',
    '#{pane_index}',
    '#{window_name}',
    '#{pane_active}',
    '#{pane_pid}',
    '#{pane_current_command}',
    '#{pane_title}',
  ].join('\t');
  const result = run('tmux', ['list-panes', '-a', '-F', format], 5_000);
  if (!result.ok) {
    return [];
  }
  return result.stdout.split('\n').filter(Boolean).map((line) => {
    const [session, windowIndex, paneIndex, windowName, active, pid, command, title] = line.split('\t');
    return {
      session,
      windowIndex,
      paneIndex,
      windowName,
      active: active === '1',
      pid: Number.parseInt(pid, 10) || 0,
      command: command || '',
      title: title || '',
    };
  });
}

function sessionEnv(session: string): Record<string, string> {
  const result = run('tmux', ['show-environment', '-t', session], 5_000);
  const env: Record<string, string> = {};
  if (!result.ok) {
    return env;
  }
  for (const line of result.stdout.split('\n')) {
    if (!line || line.startsWith('-')) continue;
    const index = line.indexOf('=');
    if (index === -1) continue;
    env[line.slice(0, index)] = line.slice(index + 1);
  }
  return env;
}

function processRows(): ProcessRow[] {
  const result = shell("ps -axo pid=,ppid=,stat=,etime=,command= | sed -n '1,20000p'", 10_000);
  if (!result.ok) {
    return [];
  }
  return result.stdout.split('\n').map((line) => {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(.+)$/);
    if (!match) return null;
    return {
      pid: Number.parseInt(match[1], 10),
      ppid: Number.parseInt(match[2], 10),
      stat: match[3],
      elapsedSeconds: parseElapsed(match[4]),
      command: truncate(match[5], 800),
    };
  }).filter((row): row is ProcessRow => row !== null);
}

function filterRelevantProcesses(rows: ProcessRow[], panes: Pane[]): ProcessRow[] {
  const byParent = new Map<number, ProcessRow[]>();
  for (const row of rows) {
    const children = byParent.get(row.ppid) ?? [];
    children.push(row);
    byParent.set(row.ppid, children);
  }

  const relevant = new Set<number>();
  const queue: number[] = [];
  for (const pane of panes) {
    if (pane.pid > 0) {
      relevant.add(pane.pid);
      queue.push(pane.pid);
    }
  }
  for (const row of rows) {
    if (isWavemillProcess(row.command)) {
      relevant.add(row.pid);
      queue.push(row.pid);
      if (row.ppid > 0) relevant.add(row.ppid);
    }
  }

  while (queue.length > 0) {
    const parent = queue.shift()!;
    for (const child of byParent.get(parent) ?? []) {
      if (relevant.has(child.pid)) continue;
      relevant.add(child.pid);
      queue.push(child.pid);
    }
  }

  return rows.filter((row) => relevant.has(row.pid));
}

function isWavemillProcess(command: string): boolean {
  return /wavemill|\/tmp\/wavemill-monitor|tend\.ts|plan-queue\.ts|ready-watchdog|tmux attach -t wavemill/.test(command);
}

function readWorkflowTasks(stateFile: string): TaskState[] {
  try {
    const parsed = JSON.parse(readFileSync(stateFile, 'utf8'));
    const tasks = parsed?.tasks;
    if (!tasks || typeof tasks !== 'object') return [];
    return Object.entries(tasks).map(([issue, value]) => {
      const task = (value ?? {}) as Record<string, unknown>;
      return {
        issue,
        slug: stringValue(task.slug),
        phase: stringValue(task.phase),
        status: stringValue(task.status),
        pr: stringValue(task.pr),
        worktree: stringValue(task.worktree),
        updated: stringValue(task.updated),
        agent: stringValue(task.agent),
        challengeRole: stringValue(task.challengeRole),
      };
    });
  } catch {
    return [];
  }
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function snapshotRepos(sessions: string[]): RepoSnapshot[] {
  const repos: RepoSnapshot[] = [];
  const seen = new Set<string>();
  for (const session of sessions) {
    const env = sessionEnv(session);
    const repoDir = env.WAVEMILL_MILL_ACTIVE || env.REPO_DIR;
    if (!repoDir || seen.has(`${session}:${repoDir}`)) continue;
    seen.add(`${session}:${repoDir}`);
    const stateDir = join(repoDir, '.wavemill');
    const workflowStatePath = join(stateDir, 'workflow-state.json');
    const logDir = join(stateDir, 'logs');
    const millLogPath = findNewestMillLog(logDir, session);
    repos.push({
      session,
      repoDir,
      workflowStatePath: existsSync(workflowStatePath) ? workflowStatePath : undefined,
      millLogPath,
      tasks: existsSync(workflowStatePath) ? readWorkflowTasks(workflowStatePath) : [],
      stateMtime: existsSync(workflowStatePath) ? statSync(workflowStatePath).mtime.toISOString() : undefined,
      logMtime: millLogPath && existsSync(millLogPath) ? statSync(millLogPath).mtime.toISOString() : undefined,
    });
  }
  return repos;
}

function findNewestMillLog(logDir: string, session: string): string | undefined {
  if (!existsSync(logDir)) return undefined;
  const candidates = readdirSync(logDir)
    .filter((name) => name.startsWith('mill-') && name.endsWith('.log'))
    .map((name) => join(logDir, name))
    .filter((path) => existsSync(path));
  const sessionLog = join(logDir, `mill-${session}.log`);
  if (existsSync(sessionLog)) return sessionLog;
  candidates.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  return candidates[0];
}

function tailLines(path: string, count: number): string[] {
  try {
    const text = readFileSync(path, 'utf8');
    return text.split('\n').slice(-count).filter(Boolean);
  } catch {
    return [];
  }
}

function buildFindings(snapshot: Omit<ObserverSnapshot, 'findings'>, options: ObserverOptions): Finding[] {
  const findings: Finding[] = [];
  const now = Date.now();
  const processByParent = new Map<number, ProcessRow[]>();
  for (const row of snapshot.processes) {
    const list = processByParent.get(row.ppid) ?? [];
    list.push(row);
    processByParent.set(row.ppid, list);
  }

  for (const repo of snapshot.repos) {
    const monitorProcesses = snapshot.processes.filter((row) =>
      row.command.includes('wavemill-monitor.sh')
      || (row.command.includes('/tmp/wavemill-monitor.sh') && row.command.includes(repo.repoDir) === false)
    );
    const activeTasks = repo.tasks.filter((task) => !terminalStatus(task.status));
    const logAgeMinutes = repo.logMtime ? (now - Date.parse(repo.logMtime)) / 60000 : undefined;
    const stateAgeMinutes = repo.stateMtime ? (now - Date.parse(repo.stateMtime)) / 60000 : undefined;

    if (activeTasks.length > 0 && logAgeMinutes !== undefined && logAgeMinutes > options.staleMinutes) {
      findings.push({
        id: `stale-log-${repo.session}-${basename(repo.repoDir)}`,
        severity: 'high',
        category: 'stuck',
        confidence: 'medium',
        session: repo.session,
        repoDir: repo.repoDir,
        title: `Mill log has not updated for ${Math.round(logAgeMinutes)} minutes while tasks are active`,
        evidence: [
          `repo=${repo.repoDir}`,
          `log=${repo.millLogPath}`,
          `logMtime=${repo.logMtime}`,
          `activeTasks=${activeTasks.map((task) => `${task.issue}:${task.phase ?? 'unknown'}`).join(', ')}`,
        ],
        recommendation: 'Inspect monitor process children for hung git/gh/network calls, then restart or nudge only the blocked child if safe.',
      });
    }

    if (activeTasks.length > 0 && stateAgeMinutes !== undefined && stateAgeMinutes > options.staleMinutes) {
      findings.push({
        id: `stale-state-${repo.session}-${basename(repo.repoDir)}`,
        severity: 'high',
        category: 'stuck',
        confidence: 'medium',
        session: repo.session,
        repoDir: repo.repoDir,
        title: `Workflow state has not updated for ${Math.round(stateAgeMinutes)} minutes while tasks are active`,
        evidence: [
          `state=${repo.workflowStatePath}`,
          `stateMtime=${repo.stateMtime}`,
          `activeTasks=${activeTasks.map((task) => `${task.issue}:${task.phase ?? 'unknown'}`).join(', ')}`,
        ],
        recommendation: 'Compare task marker files with workflow-state.json and verify the monitor loop is still progressing.',
      });
    }

    for (const task of repo.tasks) {
      if (!task.worktree || !task.slug || terminalStatus(task.status)) continue;
      const featureDir = join(task.worktree, 'features', task.slug);
      if (task.phase === 'coding' && existsSync(join(featureDir, '.coding-complete'))) {
        findings.push({
          id: `coding-marker-ignored-${task.issue}`,
          severity: 'urgent',
          category: 'stuck',
          confidence: 'high',
          session: repo.session,
          repoDir: repo.repoDir,
          issue: task.issue,
          title: `${task.issue} is still in coding even though .coding-complete exists`,
          evidence: [
            `statePhase=${task.phase}`,
            `marker=${join(featureDir, '.coding-complete')}`,
            `worktree=${task.worktree}`,
          ],
          recommendation: 'The monitor should advance this to review. Check for a hung monitor child process before restarting the session.',
        });
      }
      if (task.phase === 'planning' && existsSync(join(featureDir, '.plan-approved'))) {
        findings.push({
          id: `plan-marker-ignored-${task.issue}`,
          severity: 'urgent',
          category: 'stuck',
          confidence: 'high',
          session: repo.session,
          repoDir: repo.repoDir,
          issue: task.issue,
          title: `${task.issue} is still in planning even though .plan-approved exists`,
          evidence: [
            `statePhase=${task.phase}`,
            `marker=${join(featureDir, '.plan-approved')}`,
            `worktree=${task.worktree}`,
          ],
          recommendation: 'The monitor should launch coding. Inspect the monitor loop for a blocking external command.',
        });
      }
    }

    for (const line of repo.millLogPath ? tailLines(repo.millLogPath, options.maxLogLines) : []) {
      if (/\b(FATAL|ERROR|panic|UnhandledPromiseRejection|uncaught exception)\b/i.test(line)) {
        findings.push({
          id: `log-error-${repo.session}-${hashText(line)}`,
          severity: 'high',
          category: 'crash',
          confidence: 'medium',
          session: repo.session,
          repoDir: repo.repoDir,
          title: 'Recent mill log contains an error-level event',
          evidence: [line],
          recommendation: 'Inspect surrounding log context and file a bug if this is not a task-local failure.',
        });
      } else if (/\bWARN\b|warning|ready watchdog|queue analysis unavailable|timed out|timeout/i.test(line)) {
        findings.push({
          id: `log-warning-${repo.session}-${hashText(line)}`,
          severity: line.includes('ready watchdog') ? 'medium' : 'low',
          category: 'warning',
          confidence: 'medium',
          session: repo.session,
          repoDir: repo.repoDir,
          title: 'Recent mill log contains a warning',
          evidence: [line],
          recommendation: 'Watch for repeated occurrences. File an issue if the warning repeats or blocks progression.',
        });
      }
    }

    for (const monitor of monitorProcesses) {
      const children = processByParent.get(monitor.pid) ?? [];
      for (const child of children) {
        if (child.elapsedSeconds < options.hungMinutes * 60) continue;
        if (!/\b(git|gh|curl|npx|node|claude|codex)\b/.test(child.command)) continue;
        findings.push({
          id: `hung-child-${child.pid}`,
          severity: 'urgent',
          category: 'stuck',
          confidence: 'high',
          session: repo.session,
          repoDir: repo.repoDir,
          title: `Monitor child process appears hung for ${Math.round(child.elapsedSeconds / 60)} minutes`,
          evidence: [
            `monitorPid=${monitor.pid}`,
            `childPid=${child.pid}`,
            `elapsedSeconds=${child.elapsedSeconds}`,
            `command=${child.command}`,
          ],
          recommendation: 'If the command is conclusively blocking the monitor, terminate only the child process and verify the monitor resumes.',
        });
      }
    }
  }

  for (const pane of snapshot.panes) {
    if (/dead/i.test(pane.command) || /Pane is dead/i.test(pane.title)) {
      findings.push({
        id: `dead-pane-${pane.session}-${pane.windowIndex}-${pane.paneIndex}`,
        severity: 'medium',
        category: 'ux',
        confidence: 'medium',
        session: pane.session,
        title: `Pane ${pane.session}:${pane.windowIndex}.${pane.paneIndex} may be dead`,
        evidence: [
          `window=${pane.windowName}`,
          `command=${pane.command}`,
          `title=${pane.title}`,
        ],
        recommendation: 'Confirm with tmux capture-pane and let the monitor respawn it if it is a control pane.',
      });
    }
  }

  return dedupeFindings(findings);
}

function terminalStatus(status?: string): boolean {
  return status === 'merged' || status === 'complete' || status === 'closed' || status === 'done';
}

function hashText(text: string): string {
  let hash = 0;
  for (let i = 0; i < text.length; i += 1) {
    hash = ((hash << 5) - hash + text.charCodeAt(i)) | 0;
  }
  return Math.abs(hash).toString(36);
}

function truncate(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength)}...` : value;
}

function dedupeFindings(findings: Finding[]): Finding[] {
  const seen = new Set<string>();
  return findings.filter((finding) => {
    const key = `${finding.id}:${finding.repoDir ?? ''}:${finding.issue ?? ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function observe(options: ObserverOptions): ObserverSnapshot {
  const sessions = listSessions();
  const panes = listPanes();
  const processes = filterRelevantProcesses(processRows(), panes);
  const repos = snapshotRepos(sessions);
  const partial = {
    timestamp: new Date().toISOString(),
    sessions,
    panes,
    processes,
    repos,
  };
  return {
    ...partial,
    findings: buildFindings(partial, options),
  };
}

function renderSummary(snapshot: ObserverSnapshot): string {
  const activeTasks = snapshot.repos.flatMap((repo) => repo.tasks.filter((task) => !terminalStatus(task.status)));
  const counts: Record<Severity, number> = { urgent: 0, high: 0, medium: 0, low: 0 };
  for (const finding of snapshot.findings) {
    counts[finding.severity] += 1;
  }
  const lines = [
    `Wavemill Observer ${snapshot.timestamp}`,
    `Sessions inspected: ${snapshot.sessions.length || 0}`,
    `Repos inspected: ${snapshot.repos.length || 0}`,
    `Active tasks: ${activeTasks.length}`,
    `Findings: urgent=${counts.urgent} high=${counts.high} medium=${counts.medium} low=${counts.low}`,
  ];
  for (const finding of snapshot.findings.slice(0, 20)) {
    lines.push('');
    lines.push(`[${finding.severity}/${finding.category}/${finding.confidence}] ${finding.title}`);
    if (finding.session) lines.push(`  session: ${finding.session}`);
    if (finding.repoDir) lines.push(`  repo: ${finding.repoDir}`);
    if (finding.issue) lines.push(`  issue: ${finding.issue}`);
    for (const item of finding.evidence.slice(0, 4)) {
      lines.push(`  evidence: ${item}`);
    }
    lines.push(`  recommendation: ${finding.recommendation}`);
    if (finding.linearIssueUrl) lines.push(`  linear: ${finding.linearIssueUrl}`);
  }
  if (snapshot.findings.length > 20) {
    lines.push('');
    lines.push(`... ${snapshot.findings.length - 20} additional finding(s) omitted from text summary`);
  }
  return `${lines.join('\n')}\n`;
}

function readEnvFile(cwd = process.cwd()): Record<string, string> {
  const envPath = resolve(cwd, '.env');
  if (!existsSync(envPath)) return {};
  const env: Record<string, string> = {};
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const index = trimmed.indexOf('=');
    if (index === -1) continue;
    const key = trimmed.slice(0, index).trim();
    let value = trimmed.slice(index + 1).trim();
    value = value.replace(/^['"]|['"]$/g, '');
    env[key] = value;
  }
  return env;
}

async function linearGraphql<T>(
  apiKey: string,
  query: string,
  variables: Record<string, unknown>,
): Promise<T> {
  const response = await fetch('https://api.linear.app/graphql', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: apiKey,
    },
    body: JSON.stringify({ query, variables }),
  });
  const json = await response.json() as { data?: T; errors?: Array<{ message: string }> };
  if (!response.ok || json.errors?.length) {
    throw new Error(json.errors?.map((error) => error.message).join('; ') || `Linear HTTP ${response.status}`);
  }
  return json.data as T;
}

async function resolveLinearTeam(apiKey: string, requested?: string): Promise<string> {
  const data = await linearGraphql<{ teams: { nodes: Array<{ id: string; key: string; name: string }> } }>(
    apiKey,
    `query Teams { teams(first: 50) { nodes { id key name } } }`,
    {},
  );
  const teams = data.teams.nodes;
  const found = requested
    ? teams.find((team) => team.id === requested || team.key === requested || team.name === requested)
    : teams[0];
  if (!found) {
    throw new Error(`Linear team not found: ${requested ?? '(first team)'}`);
  }
  return found.id;
}

async function resolveLinearProject(apiKey: string, requested?: string): Promise<string | undefined> {
  if (!requested) return undefined;
  const data = await linearGraphql<{ projects: { nodes: Array<{ id: string; name: string }> } }>(
    apiKey,
    `query Projects { projects(first: 100) { nodes { id name } } }`,
    {},
  );
  const project = data.projects.nodes.find((node) => node.id === requested || node.name === requested);
  if (!project) {
    throw new Error(`Linear project not found: ${requested}`);
  }
  return project.id;
}

async function resolveLinearLabel(apiKey: string, requested?: string): Promise<string | undefined> {
  if (!requested) return undefined;
  const data = await linearGraphql<{ issueLabels: { nodes: Array<{ id: string; name: string }> } }>(
    apiKey,
    `query Labels { issueLabels(first: 100) { nodes { id name } } }`,
    {},
  );
  const label = data.issueLabels.nodes.find((node) => node.id === requested || node.name === requested);
  if (!label) {
    throw new Error(`Linear label not found: ${requested}`);
  }
  return label.id;
}

async function fileLinearIssues(snapshot: ObserverSnapshot, options: ObserverOptions): Promise<void> {
  if (options.dryRun || !options.fileLinear) return;
  const env = { ...readEnvFile(resolve(__dirname, '..')), ...readEnvFile(process.cwd()), ...process.env };
  const apiKey = env.LINEAR_API_KEY;
  if (!apiKey) {
    throw new Error('LINEAR_API_KEY not found in environment or .env');
  }
  const teamId = await resolveLinearTeam(apiKey, options.linearTeam);
  const projectId = await resolveLinearProject(apiKey, options.linearProject);
  const labelId = await resolveLinearLabel(apiKey, options.linearLabel);
  const actionable = snapshot.findings.filter((finding) =>
    finding.confidence === 'high' && (finding.severity === 'urgent' || finding.severity === 'high')
  );
  for (const finding of actionable) {
    const body = [
      `Severity: ${finding.severity}`,
      `Category: ${finding.category}`,
      `Confidence: ${finding.confidence}`,
      finding.session ? `Session: ${finding.session}` : undefined,
      finding.repoDir ? `Repo: ${finding.repoDir}` : undefined,
      finding.issue ? `Issue: ${finding.issue}` : undefined,
      '',
      'Evidence:',
      ...finding.evidence.map((item) => `- ${item}`),
      '',
      `Recommendation: ${finding.recommendation}`,
      '',
      `Detected at: ${snapshot.timestamp}`,
    ].filter((line): line is string => line !== undefined).join('\n');
    const data = await linearGraphql<{ issueCreate: { issue: { url: string } } }>(
      apiKey,
      `mutation CreateIssue($input: IssueCreateInput!) {
        issueCreate(input: $input) { issue { url } }
      }`,
      {
        input: {
          teamId,
          title: `[observer] ${finding.title}`.slice(0, 250),
          description: body,
          ...(projectId ? { projectId } : {}),
          ...(labelId ? { labelIds: [labelId] } : {}),
        },
      },
    );
    finding.linearIssueUrl = data.issueCreate.issue.url;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function observerPrompt(): string {
  return `You are the Wavemill Observer.

Run \`wavemill observer --json --once\` every few minutes and use its findings as the authoritative structured snapshot.

Act conservatively:
- If a finding identifies a conclusively hung child process blocking the monitor, terminate only that child and verify recovery.
- If the root cause is a clear Wavemill code defect, fix it in /Users/timothyogilvie/Dropbox/wavemill, add tests, commit, push, and open a PR targeting auto/integration.
- Otherwise create a Linear issue with the evidence from the observer output.
- Never kill a whole tmux session, reset worktrees, or modify active task work unless explicitly instructed.

Report after each loop: sessions inspected, active tasks, findings by severity, action taken, and next check time.
`;
}

async function main(): Promise<void> {
  let options: ObserverOptions;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error: any) {
    process.stderr.write(`Error: ${error.message}\n\n${usage()}`);
    process.exit(1);
  }

  if (options.printPrompt) {
    process.stdout.write(observerPrompt());
    return;
  }

  do {
    const snapshot = observe(options);
    await fileLinearIssues(snapshot, options);
    if (options.json) {
      process.stdout.write(`${JSON.stringify(snapshot, null, 2)}\n`);
    } else {
      process.stdout.write(renderSummary(snapshot));
    }
    if (!options.loop) break;
    await sleep(options.intervalSeconds * 1000);
  } while (true);
}

main().catch((error) => {
  process.stderr.write(`observer failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
