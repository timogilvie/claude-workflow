#!/usr/bin/env node

import { loadConfig } from '../config.js';
import { readState } from '../state.js';
import { initState, completePhase, nextPhaseInfo } from '../workflow.js';

const usage = () => {
  console.log(`Codex workflow controller

Usage:
  workflow init <feature-name> --plan <path>   Initialize state for a feature
  workflow complete <feature-name> --phase <plan|implement|validate>  Mark a phase complete
  workflow status <feature-name>               Show current state
  workflow next <feature-name>                 Show the next required action
`);
};

const parseFlag = (flag) => {
  const idx = process.argv.indexOf(flag);
  if (idx !== -1 && process.argv[idx + 1]) {
    return process.argv[idx + 1];
  }
  return null;
};

const status = (featureName) => {
  const state = readState(featureName);
  if (!state) throw new Error(`No state found for ${featureName}. Run init first.`);
  console.log(JSON.stringify(state, null, 2));
};

const main = () => {
  const [,, command, featureName] = process.argv;
  if (!command || ['-h', '--help'].includes(command)) {
    usage();
    process.exit(0);
  }

  try {
    switch (command) {
      case 'init': {
        const plan = parseFlag('--plan');
        if (!featureName || !plan) {
          throw new Error('Usage: workflow init <feature-name> --plan <path>');
        }
        const config = loadConfig();
        const state = initState({ featureName, planPath: plan, config });
        console.log(`Initialized workflow for "${featureName}"
- Branch: ${state.branch}
- Plan: ${state.planPath}
- Next: create/confirm plan, then mark "plan" complete.`);
        break;
      }
      case 'complete': {
        const phase = parseFlag('--phase');
        if (!featureName || !phase) {
          throw new Error('Usage: workflow complete <feature-name> --phase <plan|implement|validate>');
        }
        const { nextPhase } = completePhase({ featureName, phase });
        console.log(`Marked "${phase}" complete for "${featureName}".`);
        if (nextPhase) {
          console.log(`STOP: wait for human sign-off before starting "${nextPhase}".`);
        } else {
          console.log('All phases complete. Proceed to PR creation.');
        }
        break;
      }
      case 'status': {
        if (!featureName) throw new Error('Usage: workflow status <feature-name>');
        status(featureName);
        break;
      }
      case 'next': {
        if (!featureName) throw new Error('Usage: workflow next <feature-name>');
        const { state, nextPhase } = nextPhaseInfo({ featureName });
        if (!nextPhase) {
          console.log('All phases complete. Proceed to PR creation.');
          break;
        }
        console.log(`Next phase: ${nextPhase}
- Branch: ${state.branch}
- Plan: ${state.planPath}
- Checks: ${JSON.stringify(state.checks || {}, null, 2)}
STOP at the end of this phase and wait for user verification.`);
        break;
      }
      default:
        usage();
        process.exit(1);
    }
  } catch (err) {
    console.error(`Error: ${err.message || err}`);
    process.exit(1);
  }
};

main();
