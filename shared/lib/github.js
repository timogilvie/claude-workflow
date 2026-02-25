import { execSync } from 'child_process';
import { ensureCleanTree } from './git.js';
import { runBuildCheck } from './checks.js';

/**
 * Creates a pull request on GitHub after running build checks.
 *
 * @param {Object} params - Parameters for PR creation
 * @param {string} params.summary - PR summary/title
 * @param {string} [params.body=''] - PR body/description
 * @param {boolean} [params.dryRun=false] - If true, don't actually push or create PR
 * @param {string} [params.commitMessagePrefix='feat'] - Commit message prefix
 * @param {Object} [params.config] - Configuration object with checks settings
 * @returns {string} Success message with PR URL
 * @throws {Error} If build check fails
 */
export const openPullRequest = ({ summary, body = '', dryRun = false, commitMessagePrefix = 'feat', config = {} }) => {
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

  // Run build check before pushing (can be disabled via config)
  runBuildCheck(config);

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
