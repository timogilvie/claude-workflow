/**
 * Observational analysis of packet features vs. intervention outcomes.
 *
 * Loads eval records, joins with task packets, extracts features,
 * and fits an adjusted logistic model controlling for difficulty and agent type.
 * Produces a report indicating whether packet structure carries predictive signal.
 *
 * @module task-packet-signal-analyzer
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { EvalRecord } from '../../../../shared/lib/eval-schema.ts';
import { readEvalRecordsFromFile } from '../../../../shared/lib/eval-persistence.ts';
import { extractFeaturesFromText } from './task-packet-feature-extractor.ts';
import { fitLogisticRegression, welchTTest, pearson, auc, precisionRecallAtThreshold } from '../../shared/lib/stats-utils.ts';

export interface PacketObservation {
  issueId: string;
  interventionCount: number;
  interventionRequired: boolean;
  difficultyBand: string;
  agentType: string;
  timestamp: string;
  score: number;
  scoreBand: string;
  challengeSide?: string;
  features: Record<string, number>;
}

export interface GoNoGoReport {
  decision: 'GO' | 'NO-GO';
  reason: string;
  recordCount: number;
  dedupedCount: number;
  trainCount: number;
  testCount: number;
  findings: string[];
  features: Array<{
    name: string;
    unadjustedR: number;
    unadjustedP: number;
    adjustedCoeff: number;
    adjustedP: number;
    effect: string;
  }>;
  trainAuc: number;
  testAuc: number;
  precision: number;
  recall: number;
  baseRate: number;
}

/**
 * Load observations from eval records joined with task packets.
 */
export function loadPacketObservations(opts: { evalsDir: string; repoDir?: string }): PacketObservation[] {
  const evalsPath = join(opts.evalsDir, 'evals.jsonl');
  if (!existsSync(evalsPath)) {
    return [];
  }

  const records = readEvalRecordsFromFile({ file: evalsPath });
  const observations: PacketObservation[] = [];
  const seenIssueIds = new Set<string>();

  for (const record of records) {
    if (!record.issueId) continue;

    // Dedup: keep earliest per issue ID
    if (seenIssueIds.has(record.issueId)) {
      continue;
    }
    seenIssueIds.add(record.issueId);

    // Resolve artifact directory
    const artifactDir = join(opts.evalsDir, 'artifacts', record.issueId);
    const artifactDirChallenger = join(opts.evalsDir, 'artifacts', record.issueId + '_c');

    let packetPath = '';
    if (existsSync(join(artifactDir, 'task-packet.md'))) {
      packetPath = join(artifactDir, 'task-packet.md');
    } else if (existsSync(join(artifactDirChallenger, 'task-packet.md'))) {
      packetPath = join(artifactDirChallenger, 'task-packet.md');
    }

    if (!packetPath) {
      console.warn(`[packet-signal-analyzer] no artifact for ${record.issueId}`);
      continue;
    }

    try {
      const packetText = readFileSync(packetPath, 'utf-8');
      const features = extractFeaturesFromText(packetText);

      observations.push({
        issueId: record.issueId,
        interventionCount: record.interventionCount || 0,
        interventionRequired: record.interventionRequired || record.interventionCount ?? 0 > 0,
        difficultyBand: record.difficultyBand || 'unknown',
        agentType: record.agentType || 'unknown',
        timestamp: record.timestamp,
        score: record.score,
        scoreBand: record.scoreBand,
        challengeSide: record.challengeSide,
        features: featuresToDict(features),
      });
    } catch (err) {
      console.warn(`[packet-signal-analyzer] failed to load ${record.issueId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return observations;
}

function featuresToDict(features: any): Record<string, number> {
  const dict: Record<string, number> = {};
  for (const [key, val] of Object.entries(features)) {
    if (typeof val === 'number') {
      dict[key] = val;
    } else if (typeof val === 'boolean') {
      dict[key] = val ? 1 : 0;
    } else if (typeof val === 'string') {
      // Map ordinal strings to numbers
      const ordinalsMap: Record<string, Record<string, number>> = {
        proposedRisk: { low: 0, medium: 1, high: 2, unknown: -1 },
      };
      if (ordinalsMap[key]) {
        dict[key] = ordinalsMap[key][val as string] ?? -1;
      }
    }
  }
  return dict;
}

/**
 * Build a go/no-go report from observations.
 */
export function buildGoNoGoReport(
  observations: PacketObservation[],
  opts?: { trainSplit?: number; label?: 'interventions' | 'failure' | 'score' },
): GoNoGoReport {
  const trainSplit = opts?.trainSplit ?? 0.7;
  const labelType = opts?.label ?? 'interventions';

  if (observations.length === 0) {
    return {
      decision: 'NO-GO',
      reason: 'No evaluation data available',
      recordCount: 0,
      dedupedCount: 0,
      trainCount: 0,
      testCount: 0,
      findings: ['No evaluation data found.'],
      features: [],
      trainAuc: 0.5,
      testAuc: 0.5,
      precision: 0,
      recall: 0,
      baseRate: 0,
    };
  }

  // Time-split
  const sorted = [...observations].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  const splitIdx = Math.ceil(sorted.length * trainSplit);
  const train = sorted.slice(0, splitIdx);
  const test = sorted.slice(splitIdx);

  // Create label array
  const getLabel = (obs: PacketObservation): number => {
    if (labelType === 'interventions') {
      return obs.interventionCount > 0 ? 1 : 0;
    } else if (labelType === 'failure') {
      return obs.scoreBand === 'Failure' ? 1 : 0;
    } else {
      return obs.score < 0.5 ? 1 : 0;
    }
  };

  const trainLabels = train.map(getLabel);
  const testLabels = test.map(getLabel);

  // Extract feature names (packet features only, not controls)
  const packetFeatureNames = [
    'totalChars',
    'totalLines',
    'sectionCount',
    'keyFileCount',
    'reqTagCount',
    'validationScenarioCount',
    'checkboxCount',
    'implementationStepCount',
    'vaguenessMarkerCount',
  ];

  // Build feature matrix with controls
  const controlFeatureNames = ['difficultyHeuristic', 'complexityBand'];
  const agentTypes = [...new Set(observations.map((o) => o.agentType))];

  const buildX = (obs: PacketObservation[]): number[][] => {
    return obs.map((o) => {
      const row: number[] = [];
      // Packet features
      for (const name of packetFeatureNames) {
        row.push(o.features[name] || 0);
      }
      // Difficulty controls
      for (const name of controlFeatureNames) {
        row.push(o.features[name] || 0);
      }
      // Agent type one-hot
      for (const agentType of agentTypes) {
        row.push(o.agentType === agentType ? 1 : 0);
      }
      // Month index (time covariate)
      const monthDiff = new Date(o.timestamp).getMonth() - new Date(observations[0].timestamp).getMonth();
      row.push(monthDiff);
      return row;
    });
  };

  const trainX = buildX(train);
  const testX = buildX(test);

  // Fit model
  let fitResult: any = null;
  let trainPred: number[] = [];
  let testPred: number[] = [];

  try {
    fitResult = fitLogisticRegression(trainX, trainLabels, { l2: 0.1, maxIter: 100 });

    // Compute predictions
    trainPred = trainX.map((x) => {
      let eta = fitResult.intercept;
      for (let i = 0; i < fitResult.coefficients.length; i++) {
        eta += (x[i] - fitResult.standardization.means[i]) / fitResult.standardization.stds[i] * fitResult.coefficients[i];
      }
      return 1 / (1 + Math.exp(-eta));
    });

    testPred = testX.map((x) => {
      let eta = fitResult.intercept;
      for (let i = 0; i < fitResult.coefficients.length; i++) {
        eta += (x[i] - fitResult.standardization.means[i]) / fitResult.standardization.stds[i] * fitResult.coefficients[i];
      }
      return 1 / (1 + Math.exp(-eta));
    });
  } catch (err) {
    console.warn(`[packet-signal-analyzer] model fit failed: ${err}`);
  }

  // Compute metrics
  const trainAucVal = auc(trainPred, trainLabels);
  const testAucVal = auc(testPred, testLabels);
  const flagRate = trainLabels.reduce((s, l) => s + l, 0) / trainLabels.length;
  const prMetrics = precisionRecallAtThreshold(testPred, testLabels, Math.min(0.3, flagRate));

  // Feature analysis
  const findings: string[] = [];
  const features: GoNoGoReport['features'] = [];

  // Unadjusted analysis (just packet features)
  for (let i = 0; i < packetFeatureNames.length; i++) {
    const name = packetFeatureNames[i];
    const featureValues = train.map((o) => o.features[name] || 0);

    const intervened = train.filter((o) => getLabel(o) === 1).map((o) => o.features[name] || 0);
    const notIntervened = train.filter((o) => getLabel(o) === 0).map((o) => o.features[name] || 0);

    const pearsonResult = pearson(featureValues, trainLabels);
    const welchResult = intervened.length > 0 && notIntervened.length > 0 ? welchTTest(intervened, notIntervened) : { t: 0, df: 0, p: 1 };

    const adjustedCoeff = fitResult?.coefficients[i] ?? 0;
    const adjustedP = fitResult?.pValues[i] ?? 1;

    const effect = Math.abs(adjustedCoeff) > 0.1 && adjustedP < 0.05 ? 'SIGNIFICANT' : 'not significant';

    features.push({
      name,
      unadjustedR: pearsonResult.r,
      unadjustedP: pearsonResult.p,
      adjustedCoeff,
      adjustedP,
      effect,
    });

    if (effect === 'SIGNIFICANT') {
      findings.push(`${name}: p=${adjustedP.toFixed(3)}`);
    }
  }

  const baseRate = trainLabels.reduce((s, l) => s + l, 0) / trainLabels.length;
  const signalStrength = testAucVal > 0.55 && findings.length > 0;

  const decision: 'GO' | 'NO-GO' = signalStrength ? 'GO' : 'NO-GO';
  const reason = signalStrength
    ? `Signal exists: ${findings.length} significant features, test AUC=${testAucVal.toFixed(3)}`
    : `Weak or no signal: ${findings.length} significant features, test AUC=${testAucVal.toFixed(3)}`;

  return {
    decision,
    reason,
    recordCount: observations.length,
    dedupedCount: sorted.length,
    trainCount: train.length,
    testCount: test.length,
    findings,
    features,
    trainAuc: trainAucVal,
    testAuc: testAucVal,
    precision: prMetrics.precision,
    recall: prMetrics.recall,
    baseRate,
  };
}
