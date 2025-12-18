import { openPullRequest as sharedOpenPullRequest } from '../shared/lib/github.js';

export const openPullRequest = (summary: string, dryRun = false) => {
  try {
    return sharedOpenPullRequest({ summary, dryRun });
  } catch (err) {
    return `❌ Failed to create pull request: ${err}`;
  }
};
