import { classifyForReconciliation } from '../shared/lib/ready-watchdog.ts';

const mergeStatus = process.argv[2] || undefined;
const failedCheckSummary = process.argv[3] || '';
const checksRun = parseInt(process.argv[4] || '0', 10);
const checksPassed = parseInt(process.argv[5] || '0', 10);

const classification = classifyForReconciliation({
  mergeStatus,
  failedCheckSummary,
  checksRun,
  checksPassed,
});

console.log(classification);
