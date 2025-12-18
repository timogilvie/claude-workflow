import { sanitizeBranchName } from '../../shared/lib/git.js';
import { readState, writeState } from './state.js';

const phases = ['plan', 'implement', 'validate'];

export const requirePhaseOrder = (phase, state) => {
  const index = phases.indexOf(phase);
  if (index === -1) throw new Error(`Unknown phase "${phase}". Use plan|implement|validate.`);

  for (let i = 0; i < index; i += 1) {
    const p = phases[i];
    if (state.phases[p] !== 'complete') {
      throw new Error(`Cannot complete "${phase}" before "${p}" is complete.`);
    }
  }
};

export const initState = ({ featureName, planPath, config }) => {
  const branch = sanitizeBranchName(featureName, config.git?.featurePrefix || 'feature');
  const state = {
    feature: featureName,
    branch,
    planPath,
    phases: {
      plan: 'pending',
      implement: 'pending',
      validate: 'pending',
    },
    checks: config.checks || {},
  };

  writeState(featureName, state);
  return state;
};

export const completePhase = ({ featureName, phase }) => {
  const state = readState(featureName);
  if (!state) throw new Error(`No state found for ${featureName}. Run init first.`);
  requirePhaseOrder(phase, state);

  state.phases[phase] = 'complete';
  writeState(featureName, state);

  const nextPhase = phases.find((p) => state.phases[p] !== 'complete');
  return { state, nextPhase };
};

export const nextPhaseInfo = ({ featureName }) => {
  const state = readState(featureName);
  if (!state) throw new Error(`No state found for ${featureName}. Run init first.`);
  const nextPhase = phases.find((p) => state.phases[p] !== 'complete');
  return { state, nextPhase };
};
