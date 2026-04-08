#!/usr/bin/env -S npx tsx

import { runTool } from '../shared/lib/tool-runner.ts';
import { controllerCheckReadiness } from '../shared/lib/ready-stage.ts';

runTool({
  name: 'controller-ready',
  description: 'Check feature directory readiness (controller-owned, no PR required)',
  positional: {
    name: 'feature-dir',
    description: 'Absolute path to the feature directory',
  },
  options: {},
  examples: [
    '# Check readiness of a feature directory',
    'npx tsx tools/controller-ready.ts features/my-feature/',
  ],
  async run({ positional }) {
    if (positional.length === 0) {
      throw new Error('Feature directory path required');
    }

    const featureDir = positional[0];
    const result = await controllerCheckReadiness(featureDir);

    console.log(JSON.stringify(result, null, 2));

    if (!result.ready) {
      process.exit(1);
    }
  },
});
