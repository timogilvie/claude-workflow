/**
 * Analyze packet signal: check if task packet structure predicts intervention outcomes.
 *
 * Usage:
 *   npx tsx tools/analyze-packet-signal.ts --repo-dir /path/to/repo
 *   npx tsx tools/analyze-packet-signal.ts --repo-dir /path/to/repo --json
 *   npx tsx tools/analyze-packet-signal.ts --repo-dir /path/to/repo --label failure
 */

import { join } from 'node:path';
import { runTool } from '../shared/lib/tool-runner.ts';
import { loadPacketObservations, buildGoNoGoReport } from '../src/evaluation/scorers/wavemill/task-packet-signal-analyzer.ts';

runTool({
  name: 'analyze-packet-signal',
  description: 'Analyze whether task packet structure predicts intervention outcomes',
  async run({ flags, positional, args }) {
    const repoDir = flags['repo-dir'] || flags.repoDir || process.cwd();
    const evalsDir = join(repoDir, '.wavemill', 'evals');
    const label = (flags.label as string) || 'interventions';
    const outputJson = flags.json || flags.output === 'json';

    console.error(`[analyze-packet-signal] Loading observations from ${evalsDir}`);

    const observations = loadPacketObservations({ evalsDir, repoDir });

    if (observations.length === 0) {
      console.log('No evaluation data found.');
      process.exit(0);
    }

    console.error(`[analyze-packet-signal] Loaded ${observations.length} unique observations`);

    const report = buildGoNoGoReport(observations, { label: label as any });

    if (outputJson) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      // Pretty-print the report
      console.log();
      console.log('╔════════════════════════════════════════════════════════════════╗');
      console.log('║                   PACKET SIGNAL ANALYSIS REPORT                  ║');
      console.log('╚════════════════════════════════════════════════════════════════╝');
      console.log();
      console.log(`Decision: ${report.decision}`);
      console.log(`Reason:   ${report.reason}`);
      console.log();
      console.log('Counts:');
      console.log(`  Total records: ${report.recordCount}`);
      console.log(`  Deduped (earliest per issue): ${report.dedupedCount}`);
      console.log(`  Train set (70%): ${report.trainCount}`);
      console.log(`  Test set (30%):  ${report.testCount}`);
      console.log();
      console.log('Model performance:');
      console.log(`  Train AUC: ${report.trainAuc.toFixed(3)}`);
      console.log(`  Test AUC:  ${report.testAuc.toFixed(3)}`);
      console.log(`  Precision @ flag-rate: ${report.precision.toFixed(3)}`);
      console.log(`  Recall:                ${report.recall.toFixed(3)}`);
      console.log(`  Base rate (intervention): ${(report.baseRate * 100).toFixed(1)}%`);
      console.log();

      if (report.findings.length > 0) {
        console.log(`Significant packet features (${report.findings.length}):`);
        for (const finding of report.findings) {
          console.log(`  - ${finding}`);
        }
      } else {
        console.log('No significant packet features found.');
      }

      console.log();
      console.log('Feature-by-feature analysis:');
      console.log();
      const headers = ['Feature', 'Unadjusted r', 'Unadjusted p', 'Adjusted coeff', 'Adjusted p', 'Significant'];
      const colWidths = [25, 14, 14, 16, 12, 12];

      // Print header
      let header = '';
      for (let i = 0; i < headers.length; i++) {
        header += headers[i].padEnd(colWidths[i]);
      }
      console.log(header);
      console.log('-'.repeat(header.length));

      // Print rows
      for (const feature of report.features) {
        const row = [
          feature.name.padEnd(colWidths[0]),
          feature.unadjustedR.toFixed(3).padEnd(colWidths[1]),
          feature.unadjustedP.toFixed(3).padEnd(colWidths[2]),
          feature.adjustedCoeff.toFixed(3).padEnd(colWidths[3]),
          feature.adjustedP.toFixed(3).padEnd(colWidths[4]),
          feature.effect.padEnd(colWidths[5]),
        ].join('');
        console.log(row);
      }

      console.log();
    }

    process.exit(report.decision === 'GO' ? 0 : 1);
  },
});
