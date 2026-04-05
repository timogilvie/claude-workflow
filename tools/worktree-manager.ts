#!/usr/bin/env -S npx tsx
import { runTool } from '../shared/lib/tool-runner.ts';
import {
  createWorktree,
  getWorktreeStatus,
  listWorktrees,
  pruneWorktrees,
  removeWorktree,
} from '../shared/lib/worktree-manager.ts';

runTool({
  name: 'worktree-manager',
  description: 'Git Worktree Manager for Parallel Workflows',
  options: {
    'delete-branch': { type: 'boolean', description: 'Delete branch when removing worktree' },
  },
  positional: {
    name: 'command args',
    description: 'Command (create|list|status|remove|prune) and arguments',
    multiple: true,
  },
  examples: [
    'npx tsx tools/worktree-manager.ts create "Add caching layer"',
    'npx tsx tools/worktree-manager.ts create "Add feature" main',
    'npx tsx tools/worktree-manager.ts list',
    'npx tsx tools/worktree-manager.ts status',
    'npx tsx tools/worktree-manager.ts remove add-caching-layer --delete-branch',
    'npx tsx tools/worktree-manager.ts prune',
  ],
  additionalHelp: `Commands:
  create <branch-name> [base]  Create worktree for feature
  list                         List all worktrees
  status                       Show detailed status of all worktrees
  remove <branch-name>         Remove worktree
  prune                        Clean up stale worktrees

Environment:
  WORKTREE_BASE                Base directory for worktrees (default: ~/worktrees)`,
  run({ args, positional }) {
    const command = positional[0];
    const commandArgs = positional.slice(1);

    switch (command) {
      case 'create':
        if (!commandArgs[0]) {
          throw new Error('branch-name is required for create command');
        }
        createWorktree(commandArgs[0], commandArgs[1]);
        break;

      case 'list':
        listWorktrees();
        break;

      case 'status':
        getWorktreeStatus();
        break;

      case 'remove':
        if (!commandArgs[0]) {
          throw new Error('branch-name is required for remove command');
        }
        removeWorktree(commandArgs[0], !!args['delete-branch']);
        break;

      case 'prune':
        pruneWorktrees();
        break;

      default:
        throw new Error(`Unknown command "${command}"\nValid commands: create, list, status, remove, prune`);
    }
  },
});
