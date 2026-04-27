#!/usr/bin/env -S npx tsx

import { runTool } from '../shared/lib/tool-runner.ts';
import {
  recordRuntimeResourceSelection,
  resolveRuntimeResourceContent,
} from '../shared/lib/resource-selection.ts';

runTool({
  name: 'resolve-runtime-resource',
  description: 'Resolve governed runtime prompt/artifact resources',
  options: {
    surface: {
      type: 'string',
      description: 'Resource surface: planner or reviewer',
    },
    'repo-dir': {
      type: 'string',
      description: 'Repository directory (default: current directory)',
    },
    json: {
      type: 'boolean',
      description: 'Emit machine-readable JSON',
    },
  },
  async run({ args }) {
    const surface = args.surface;
    if (surface !== 'planner' && surface !== 'reviewer') {
      throw new Error('--surface must be planner or reviewer');
    }

    const repoDir = args['repo-dir'] || process.cwd();
    const result = resolveRuntimeResourceContent(surface, { repoDir });
    if (result.selection.resourceRef) {
      recordRuntimeResourceSelection(result.selection, { repoDir });
    }

    if (!args.json) {
      if (result.content === null) {
        throw new Error(result.error || 'resource content unavailable');
      }
      console.log(result.content);
      return;
    }

    console.log(JSON.stringify(result, null, 2));
  },
});
