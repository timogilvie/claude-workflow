import assert from 'assert';
import { initState, completePhase, nextPhaseInfo } from '../src/workflow.js';
import { loadConfig } from '../src/config.js';
import { readState } from '../src/state.js';

const feature = 'test-feature';
const planPath = 'features/test-feature/plan.md';
const config = loadConfig();

// init state
const state = initState({ featureName: feature, planPath, config });
assert(state.phases.plan === 'pending', 'plan should be pending after init');

// complete plan
const { nextPhase } = completePhase({ featureName: feature, phase: 'plan' });
assert(nextPhase === 'implement', 'next phase should be implement');

// ensure state persisted
const persisted = readState(feature);
assert(persisted.phases.plan === 'complete', 'plan should be complete after marking');

// complete remaining phases
completePhase({ featureName: feature, phase: 'implement' });
completePhase({ featureName: feature, phase: 'validate' });

const { nextPhase: done } = nextPhaseInfo({ featureName: feature });
assert(!done, 'no next phase after all complete');

console.log('workflow-state.test.js passed');
