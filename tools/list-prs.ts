#!/usr/bin/env -S npx tsx

/**
 * List PRs Tool
 *
 * Lists GitHub pull requests with optional filtering by state, author, and branch pattern.
 * Wraps listPullRequests() from shared/lib/github.js and adds client-side branch filtering.
 *
 * Usage:
 *   npx tsx tools/list-prs.ts [options]
 *
 * Options:
 *   --state <open|closed|all>  Filter by PR state (default: open)
 *   --author <username>        Filter by PR author
 *   --branch <pattern>         Filter by branch name pattern (supports wildcards)
 *   --limit <number>           Maximum number of PRs to fetch (default: 50)
 *   --help, -h                 Show this help message
 *
 * Examples:
 *   npx tsx tools/list-prs.ts
 *   npx tsx tools/list-prs.ts --state closed
 *   npx tsx tools/list-prs.ts --author timogilvie
 *   npx tsx tools/list-prs.ts --branch "feature/*"
 *   npx tsx tools/list-prs.ts --state all --author octocat --branch "task/*"
 */

import { listPullRequests } from '../shared/lib/github.js';

// ────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────

interface Args {
  state: 'open' | 'closed' | 'all';
  author?: string;
  branch?: string;
  limit: number;
  help: boolean;
}

interface PR {
  number: number;
  title: string;
  state: string;
  author: string;
  headRefName: string;
  baseRefName: string;
  labels: any[];
  url: string;
  createdAt: string;
  updatedAt: string;
  mergedAt: string | null;
  closedAt: string | null;
}

// ────────────────────────────────────────────────────────────────
// Argument Parsing
// ────────────────────────────────────────────────────────────────

function parseArgs(argv: string[]): Args {
  const args: Args = {
    state: 'open',
    limit: 50,
    help: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    if (arg === '--help' || arg === '-h') {
      args.help = true;
    } else if (arg === '--state' && argv[i + 1]) {
      const state = argv[++i];
      if (!['open', 'closed', 'all'].includes(state)) {
        console.error(`Error: Invalid state "${state}". Must be one of: open, closed, all`);
        process.exit(1);
      }
      args.state = state as 'open' | 'closed' | 'all';
    } else if (arg === '--author' && argv[i + 1]) {
      args.author = argv[++i];
    } else if (arg === '--branch' && argv[i + 1]) {
      args.branch = argv[++i];
    } else if (arg === '--limit' && argv[i + 1]) {
      const limit = parseInt(argv[++i], 10);
      if (isNaN(limit) || limit < 1) {
        console.error(`Error: Invalid limit "${argv[i]}". Must be a positive number.`);
        process.exit(1);
      }
      args.limit = limit;
    }
  }

  return args;
}

function showHelp(): void {
  console.log(`
List PRs Tool — List GitHub pull requests with filtering

Usage:
  npx tsx tools/list-prs.ts [options]

Options:
  --state <open|closed|all>  Filter by PR state (default: open)
  --author <username>        Filter by PR author
  --branch <pattern>         Filter by branch name pattern (supports wildcards)
  --limit <number>           Maximum number of PRs to fetch (default: 50)
  --help, -h                 Show this help message

Examples:
  # List open PRs (default)
  npx tsx tools/list-prs.ts

  # List closed PRs
  npx tsx tools/list-prs.ts --state closed

  # List PRs by specific author
  npx tsx tools/list-prs.ts --author octocat

  # List PRs from feature branches
  npx tsx tools/list-prs.ts --branch "feature/*"

  # Combine filters
  npx tsx tools/list-prs.ts --state all --author timogilvie --branch "task/*"

Output:
  JSON array of PR objects with fields:
  - number, title, state, author
  - headRefName (branch), baseRefName
  - labels, url
  - createdAt, updatedAt, mergedAt, closedAt
`);
}

// ────────────────────────────────────────────────────────────────
// Branch Pattern Matching
// ────────────────────────────────────────────────────────────────

/**
 * Match a branch name against a glob-style pattern.
 * Supports wildcards (*) for any characters.
 *
 * Examples:
 *   matchBranchPattern("feature/add-x", "feature/*") => true
 *   matchBranchPattern("feature/add-x", "*feature*") => true
 *   matchBranchPattern("main", "feature/*") => false
 */
function matchBranchPattern(branchName: string, pattern: string): boolean {
  // Convert glob pattern to regex
  // Escape special regex chars except *
  const regexPattern = pattern
    .replace(/[.+?^${}()|[\]\\]/g, '\\$&')  // Escape special chars
    .replace(/\*/g, '.*');                   // Convert * to .*

  const regex = new RegExp(`^${regexPattern}$`);
  return regex.test(branchName);
}

// ────────────────────────────────────────────────────────────────
// Main Entry Point
// ────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv.slice(2));

  // Show help
  if (args.help) {
    showHelp();
    process.exit(0);
  }

  try {
    // Fetch PRs from GitHub using shared library
    const prs = listPullRequests({
      state: args.state,
      author: args.author,
      limit: args.limit,
    }) as PR[];

    // Apply client-side branch filtering if pattern provided
    let filteredPRs = prs;
    if (args.branch) {
      filteredPRs = prs.filter(pr => matchBranchPattern(pr.headRefName, args.branch!));
    }

    // Output JSON
    console.log(JSON.stringify(filteredPRs, null, 2));
  } catch (error) {
    console.error(`Error: ${(error as Error).message}`);
    process.exit(1);
  }
}

main();
