#!/usr/bin/env node
/** Observational packet-signal analysis; reads eval data and never mutates it. */
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { runTool } from '../shared/lib/tool-runner.ts';
import { extractTaskPacketFeaturesFromPath } from '../src/evaluation/scorers/task-packet-feature-extractor.ts';
import { auc, logisticRegression, mannWhitneyU, pointBiserial, standardize, timeSplit } from '../src/evaluation/scorers/task-packet-stats.ts';

type EvalRow = Record<string, unknown> & { issueId?: string; timestamp?: string; interventionRequired?: boolean; difficultyBand?: string; difficultySignals?: { locTouched?: number; filesTouched?: number }; taskContext?: { complexity?: string } };
const FEATURES = ['total_chars', 'file_count', 'new_file_count', 'sections_present', 'validation_is_boilerplate', 'vague_word_density', 'difficulty', 'complexity'] as const;
const BANDS: Record<string, number> = { trivial: 0, easy: 0, medium: 1, hard: 2, very_hard: 3 };
const COMPLEXITY: Record<string, number> = { xs: 0, s: 1, m: 2, l: 3, xl: 4 };

function readRows(path: string): EvalRow[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split('\n').flatMap((line) => { try { return line.trim() ? [JSON.parse(line) as EvalRow] : []; } catch { return []; } });
}

runTool({
  name: 'analyze-packet-signal', description: 'Measure task-packet signal while controlling for task difficulty.',
  options: {
    'repo-dir': { type: 'string', description: 'Repository containing .wavemill/evals' },
    evals: { type: 'string', description: 'Path to evals.jsonl' }, artifacts: { type: 'string', description: 'Artifact root' },
    json: { type: 'boolean', description: 'Print machine-readable report' }, 'emit-weights': { type: 'boolean', description: 'Print fitted standardized coefficients' },
    'train-fraction': { type: 'string', description: 'Earliest fraction used for training', default: '0.7' },
  },
  async run({ args }) {
    const repoDir = resolve(args['repo-dir'] ?? process.cwd());
    const evalsPath = resolve(args.evals ?? join(repoDir, '.wavemill/evals/evals.jsonl'));
    const artifacts = resolve(args.artifacts ?? join(repoDir, '.wavemill/evals/artifacts'));
    const raw = readRows(evalsPath);
    if (!raw.length) { process.stdout.write('No evaluation data found.\n'); return; }
    const latest = new Map<string, EvalRow>();
    for (const row of raw.filter((row) => row.issueId)) {
      const old = latest.get(row.issueId!);
      if (!old || String(row.timestamp ?? '') >= String(old.timestamp ?? '')) latest.set(row.issueId!, row);
    }
    const rows: Array<{ row: EvalRow; f: Awaited<ReturnType<typeof extractTaskPacketFeaturesFromPath>>; y: number }> = [];
    for (const row of latest.values()) {
      try { rows.push({ row, f: await extractTaskPacketFeaturesFromPath(join(artifacts, row.issueId!)), y: row.interventionRequired === true ? 1 : 0 }); }
      catch { process.stderr.write(`Warning: missing or unreadable task packet for ${row.issueId}; skipping.\n`); }
    }
    if (!rows.length) { process.stdout.write('No evaluation data found.\n'); return; }
    rows.sort((a, b) => String(a.row.timestamp ?? '').localeCompare(String(b.row.timestamp ?? '')));
    const labels = rows.map((item) => item.y);
    const perFeature = Object.fromEntries(FEATURES.map((feature) => {
      const values = rows.map((item) => item.f[feature]); const mw = mannWhitneyU(values.filter((_, i) => labels[i]), values.filter((_, i) => !labels[i]));
      return [feature, { pointBiserial: pointBiserial(values, labels), p: mw.p }];
    }));
    const controls = rows.map(({ row, f }) => [BANDS[row.difficultyBand ?? 'medium'] ?? 1, row.difficultySignals?.locTouched ?? 0, row.difficultySignals?.filesTouched ?? 0, COMPLEXITY[row.taskContext?.complexity ?? 'm'] ?? f.complexity, f.difficulty, f.complexity]);
    const matrix = rows.map(({ f }, i) => [...controls[i], ...FEATURES.map((feature) => f[feature])]);
    const standardized = standardize(matrix);
    const split = timeSplit(rows, Number(args['train-fraction']) || .7);
    const trainLength = split.train.length;
    const fit = logisticRegression(standardized.values.slice(0, trainLength), labels.slice(0, trainLength), { l2: .1 });
    const testScores = standardized.values.slice(trainLength).map((vector) => 1 / (1 + Math.exp(-fit.coefficients.reduce((sum, weight, i) => sum + weight * (i ? vector[i - 1] : 1), 0))));
    const testLabels = labels.slice(trainLength);
    const significant = Object.entries(perFeature).filter(([, value]) => value.p < .05).map(([feature]) => feature);
    const report = { records: rows.length, baseRate: labels.reduce((sum, y) => sum + y, 0) / labels.length, perFeature, holdoutAuc: auc(testScores, testLabels), go: significant.length > 0, significantFeatures: significant };
    if (args.json) process.stdout.write(`${JSON.stringify(report)}\n`);
    else process.stdout.write(`Task packet signal report: ${rows.length} packets; intervention base rate ${(report.baseRate * 100).toFixed(1)}%; hold-out AUC ${report.holdoutAuc.toFixed(3)}. ${report.go ? `GO: significant packet features: ${significant.join(', ')}.` : 'NO-GO: no univariate packet feature met p < 0.05.'}\n`);
    if (args['emit-weights']) process.stdout.write(`${JSON.stringify({ intercept: fit.coefficients[0], weights: Object.fromEntries([...FEATURES].map((feature, i) => [feature, fit.coefficients[controls[0].length + i + 1]])), means: standardized.means, sds: standardized.sds })}\n`);
  },
});
