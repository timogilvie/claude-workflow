import { createBranch, sanitizeBranchName } from '../shared/lib/git.js';

export const createGitBranch = (name: string, prefix = 'feature') => {
  try {
    const branchName = createBranch(name, prefix);
    return `✅ Created and switched to branch: ${branchName}`;
  } catch (err) {
    return `❌ Failed to create branch: ${err}`;
  }
};

export const formatBranchName = (name: string, prefix = 'feature') => {
  return sanitizeBranchName(name, prefix);
};
