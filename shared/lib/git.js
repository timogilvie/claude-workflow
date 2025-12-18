import { execSync } from 'child_process';

export const sanitizeBranchName = (name, prefix = 'feature') => {
  const sanitized = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50);

  return `${prefix}/${sanitized}`;
};

export const ensureCleanTree = () => {
  const status = execSync('git status --porcelain', { encoding: 'utf-8' }).trim();
  if (status) {
    throw new Error('Working tree is dirty. Commit or stash changes before proceeding.');
  }
};

export const createBranch = (name, prefix = 'feature') => {
  const branchName = sanitizeBranchName(name, prefix);
  execSync(`git checkout -b ${branchName}`, { stdio: 'inherit' });
  return branchName;
};

export const currentBranch = () => {
  return execSync('git branch --show-current', { encoding: 'utf-8' }).trim();
};
