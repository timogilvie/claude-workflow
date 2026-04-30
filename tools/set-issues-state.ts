#!/usr/bin/env -S npx tsx

import { runTool } from '../shared/lib/tool-runner.ts';
import { setIssuesState } from '../shared/lib/linear.ts';

runTool({
  name: 'set-issues-state',
  description: 'Set the state of multiple Linear issues',
  options: {
    state: {
      type: 'string',
      description: 'State name',
      default: 'In Progress',
    },
  },
  positional: {
    name: 'identifiers...',
    description: 'One or more issue identifiers',
    required: true,
  },
  examples: [
    'npx tsx tools/set-issues-state.ts HOK-123 HOK-124',
    'npx tsx tools/set-issues-state.ts --state "Done" HOK-123 HOK-124',
  ],
  async run({ positional, options }) {
    if (!positional || positional.length === 0) {
      throw new Error('At least one issue identifier is required');
    }

    const stateName = options.state || 'In Progress';
    const result = await setIssuesState(positional, stateName);
    console.log(JSON.stringify(result, null, 2));

    // Surface a human-readable summary for the shell wrapper to capture.
    // The shell pipes stderr to a temp file so it doesn't get lost in
    // /dev/null like the previous implementation did.
    if (result.failed.length > 0) {
      const total = result.updated.length + result.failed.length;
      const details = result.failed
        .slice(0, 5)
        .map((f) => `${f.issueId}: ${f.error}`)
        .join('; ');
      const truncated = result.failed.length > 5 ? ` (+${result.failed.length - 5} more)` : '';
      console.error(
        `WARN: Linear state update to '${stateName}' failed for ${result.failed.length}/${total} issue(s): ${details}${truncated}`,
      );
    }

    // Only exit non-zero when *everything* failed. Partial failures are
    // surfaced via the JSON output and stderr summary, so the caller can
    // continue with the issues that did update.
    if (result.updated.length === 0 && result.failed.length > 0) {
      process.exit(1);
    }
  },
});
