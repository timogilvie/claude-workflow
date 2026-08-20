#!/usr/bin/env -S npx tsx

import { resolve } from 'node:path';
import { runTool } from '../shared/lib/tool-runner.ts';
import {
  INCIDENT_SEED_OBSERVATIONS,
  computeStageContextFloorRecommendations,
  formatStageContextFloorReport,
  readObservationFile,
  scanNativeSessionTranscripts,
} from '../shared/lib/stage-context-floor-derivation.ts';
import { STAGE_CONTEXT_WINDOW_FLOORS } from '../shared/lib/stage-context-floors.ts';

runTool({
  name: 'derive-stage-context-floors',
  description: 'Derive per-stage native model context-window floors from native-run prompt observations. Only native runs are instrumented; Claude-harness runs are intentionally out of scope.',
  options: {
    observations: {
      type: 'string',
      description: 'JSONL observation file. Defaults to .wavemill/evals/stage-prompt-observations.jsonl.',
    },
    transcripts: {
      type: 'string',
      description: 'Bootstrap by scanning a runs directory for **/native-sessions/*.jsonl transcripts.',
    },
    check: {
      type: 'boolean',
      description: 'Exit 1 if any recommendation exceeds the active checked-in floor.',
    },
  },
  examples: [
    'npx tsx tools/derive-stage-context-floors.ts',
    'npx tsx tools/derive-stage-context-floors.ts --transcripts ~/Dropbox/wavemill/.wavemill/runs',
    'npx tsx tools/derive-stage-context-floors.ts --check',
  ],
  async run({ args }) {
    const observationsPath = resolve(String(args.observations ?? '.wavemill/evals/stage-prompt-observations.jsonl'));
    const transcriptRoot = typeof args.transcripts === 'string' ? resolve(args.transcripts) : undefined;
    const observations = [
      ...INCIDENT_SEED_OBSERVATIONS,
      ...readObservationFile(observationsPath),
      ...(transcriptRoot ? scanNativeSessionTranscripts(transcriptRoot) : []),
    ];
    const recommendations = computeStageContextFloorRecommendations(observations);
    console.log(formatStageContextFloorReport(recommendations));

    if (args.check === true) {
      const drift = recommendations.filter((recommendation) => (
        recommendation.recommendedFloor > STAGE_CONTEXT_WINDOW_FLOORS[recommendation.stage].floorTokens
      ));
      if (drift.length > 0) {
        console.error(`Context floor drift detected: ${drift.map((item) => `${item.stage}:${item.recommendedFloor}`).join(', ')}`);
        process.exit(1);
      }
    }
  },
});
