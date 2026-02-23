import { execSync } from 'child_process';
import { ensureCleanTree } from './git.js';

export const openPullRequest = ({ summary, body = '', dryRun = false, commitMessagePrefix = 'feat' }) => {
  const status = execSync('git status --porcelain', { encoding: 'utf-8' }).trim();

  if (status && dryRun) {
    return '⚠️ Dry run: changes detected but not committed/pushed.';
  }

  if (status) {
    execSync(`git add .`, { stdio: 'inherit' });
    execSync(`git commit -m "${commitMessagePrefix}: ${summary}"`, { stdio: 'inherit' });
  }

  if (dryRun) {
    return '✅ Dry run complete (no push/PR created).';
  }

  ensureCleanTree();
  execSync(`git push --set-upstream origin HEAD`, { stdio: 'inherit' });
  const title = `${commitMessagePrefix}: ${summary}`;
  const prArgs = ['gh', 'pr', 'create', '--title', title];
  if (body) {
    prArgs.push('--body', body);
  } else {
    prArgs.push('--body', `## Summary\n\n${summary}`);
  }
  const prOutput = execSync(prArgs.map(a => `'${a.replace(/'/g, "'\\''")}'`).join(' '), { encoding: 'utf-8' });
  return `✅ Pull request created: ${prOutput}`;
};
