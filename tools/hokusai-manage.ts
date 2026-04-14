#!/usr/bin/env -S npx tsx

import { runTool } from '../shared/lib/tool-runner.ts';
import {
  disableSubmission,
  enableSubmission,
  getStatusDisplay,
  getSubmissionStatus,
} from '../shared/lib/hokusai-consent.ts';

runTool({
  name: 'hokusai-manage',
  description: 'Manage Hokusai data submission opt-in',
  options: {
    json: { type: 'boolean', description: 'Output status as JSON when supported' },
    yes: { type: 'boolean', description: 'Skip the interactive consent prompt when enabling' },
    'config-dir': { type: 'string', description: 'Override the user config directory (defaults to ~/.wavemill)' },
    'repo-dir': { type: 'string', description: 'Override the repo directory used to read .wavemill-config.json' },
  },
  positional: {
    name: 'command',
    required: true,
    multiple: true,
    description: 'Command (enable|disable|status|check-consent)',
  },
  examples: [
    'npx tsx tools/hokusai-manage.ts status',
    'npx tsx tools/hokusai-manage.ts enable',
    'npx tsx tools/hokusai-manage.ts disable',
    'npx tsx tools/hokusai-manage.ts check-consent',
  ],
  async run({ args, positional }) {
    const command = positional[0];
    const options = {
      configDir: args['config-dir'],
      repoDir: args['repo-dir'],
    };

    switch (command) {
      case 'enable': {
        const enabled = await enableSubmission({
          ...options,
          skipPrompt: !!args.yes,
        });
        const status = getSubmissionStatus(options);
        if (args.json) {
          console.log(JSON.stringify(status, null, 2));
        } else if (enabled) {
          console.log(getStatusDisplay(options));
        } else {
          console.log('Hokusai data submission remains disabled.');
        }
        process.exitCode = enabled ? 0 : 1;
        return;
      }

      case 'disable': {
        disableSubmission(args['config-dir']);
        if (args.json) {
          console.log(JSON.stringify(getSubmissionStatus(options), null, 2));
        } else {
          console.log(getStatusDisplay(options));
        }
        return;
      }

      case 'status': {
        const status = getSubmissionStatus(options);
        if (args.json) {
          console.log(JSON.stringify(status, null, 2));
        } else {
          console.log(getStatusDisplay(options));
        }
        return;
      }

      case 'check-consent': {
        const status = getSubmissionStatus(options);
        if (args.json) {
          console.log(JSON.stringify(status, null, 2));
        }
        process.exitCode = status.submissionAllowed ? 0 : 1;
        return;
      }

      default:
        throw new Error(
          `Unknown command "${command}"\nValid commands: enable, disable, status, check-consent`,
        );
    }
  },
});
