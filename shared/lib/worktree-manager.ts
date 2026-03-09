import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { sanitizeBranchName } from './git.js';

export function getWorktreeBase(): string {
  return process.env.WORKTREE_BASE || path.join(process.env.HOME!, 'worktrees');
}

export function getWorktreePath(branchName: string, baseDir: string = getWorktreeBase()): string {
  const fullBranchName = sanitizeBranchName(branchName);
  const sanitized = fullBranchName.split('/')[1];
  return path.join(baseDir, sanitized);
}

function run(cmd: string, options: { cwd?: string; silent?: boolean } = {}): string {
  try {
    const result = execSync(cmd, {
      cwd: options.cwd,
      encoding: 'utf-8',
      stdio: options.silent ? 'pipe' : 'inherit',
    });
    return typeof result === 'string' ? result.trim() : '';
  } catch (error: any) {
    if (options.silent) {
      return '';
    }
    throw error;
  }
}

export function getMainBranch(): string {
  const branches = run('git branch -l main master', { silent: true });
  if (branches.includes('main')) {
    return 'main';
  }
  if (branches.includes('master')) {
    return 'master';
  }
  return 'main';
}

export function createWorktree(branchName: string, baseBranch?: string): void {
  const mainBranch = baseBranch || getMainBranch();
  const remoteRef = `origin/${mainBranch}`;
  const fullBranchName = sanitizeBranchName(branchName);
  const sanitized = fullBranchName.split('/')[1];
  const worktreeBase = getWorktreeBase();
  const worktreePath = path.join(worktreeBase, sanitized);

  if (!fs.existsSync(worktreeBase)) {
    fs.mkdirSync(worktreeBase, { recursive: true });
  }

  if (fs.existsSync(worktreePath)) {
    console.log(`Worktree already exists at: ${worktreePath}`);
    return;
  }

  console.log(`Fetching latest ${mainBranch} from origin...`);
  run(`git fetch origin ${mainBranch}`, { silent: true });

  const existingBranches = run('git branch --list', { silent: true });
  if (existingBranches.includes(fullBranchName)) {
    console.log(`Branch ${fullBranchName} exists, resetting to ${remoteRef}`);
    run(`git branch -f ${fullBranchName} ${remoteRef}`);
  } else {
    console.log(`Creating branch: ${fullBranchName} from ${remoteRef}`);
    run(`git branch ${fullBranchName} ${remoteRef}`);
  }

  console.log(`Creating worktree at: ${worktreePath}`);
  run(`git worktree add "${worktreePath}" ${fullBranchName}`);

  const featureDir = path.join(worktreePath, 'features', sanitized);
  fs.mkdirSync(featureDir, { recursive: true });

  console.log('\n✅ Worktree created successfully');
  console.log(`   Path: ${worktreePath}`);
  console.log(`   Branch: ${fullBranchName}`);
  console.log(`   Feature dir: features/${sanitized}/`);
}

export function listWorktrees(): void {
  console.log('Git Worktrees:\n');
  run('git worktree list');
}

export function getWorktreeStatus(): void {
  const output = run('git worktree list --porcelain', { silent: true });
  const worktrees = output.split('\n\n').filter(Boolean);

  console.log('Worktree Status:\n');
  console.log('─'.repeat(60));

  for (const worktree of worktrees) {
    const lines = worktree.split('\n');
    const worktreePath = lines.find((line) => line.startsWith('worktree '))?.replace('worktree ', '');
    const branch = lines.find((line) => line.startsWith('branch '))?.replace('branch refs/heads/', '');

    if (!worktreePath || worktreePath === process.cwd()) {
      continue;
    }

    const status = run('git status --porcelain', { cwd: worktreePath, silent: true });
    const changes = status.split('\n').filter(Boolean).length;

    const sessionFile = path.join(worktreePath, '.parallel-workflow', 'session.json');
    let phase = 'unknown';
    if (fs.existsSync(sessionFile)) {
      const session = JSON.parse(fs.readFileSync(sessionFile, 'utf-8'));
      phase = session.phase || 'unknown';
    }

    console.log(`📁 ${path.basename(worktreePath)}`);
    console.log(`   Path: ${worktreePath}`);
    console.log(`   Branch: ${branch}`);
    console.log(`   Changes: ${changes > 0 ? `${changes} files modified` : 'clean'}`);
    console.log(`   Phase: ${phase}`);
    console.log('');
  }
}

export function removeWorktree(branchName: string, deleteBranch = false): void {
  const fullBranchName = sanitizeBranchName(branchName);
  const worktreePath = getWorktreePath(branchName);

  if (!fs.existsSync(worktreePath)) {
    console.log(`Worktree not found: ${worktreePath}`);
    return;
  }

  const status = run('git status --porcelain', { cwd: worktreePath, silent: true });
  if (status) {
    console.log('⚠️  Worktree has uncommitted changes:');
    console.log(status);
    console.log('\nUse --force to remove anyway');
    return;
  }

  console.log(`Removing worktree: ${worktreePath}`);
  run(`git worktree remove "${worktreePath}"`);

  if (deleteBranch) {
    console.log(`Deleting branch: ${fullBranchName}`);
    run(`git branch -d ${fullBranchName}`, { silent: true });
  }

  console.log('✅ Worktree removed');
}

export function pruneWorktrees(): void {
  console.log('Pruning stale worktrees...');
  run('git worktree prune');
  console.log('✅ Stale worktrees pruned');
}
