#!/usr/bin/env -S npx tsx

import { writePreflightDiagnostic } from '../shared/lib/ready-diagnostics.ts';
import { runTool } from '../shared/lib/tool-runner.ts';

runTool({
  name: 'ready-preflight-diagnostic',
  description: 'Append a structured ready preflight diagnostic entry',
  options: {
    'state-dir': { type: 'string', description: 'Ready state directory' },
    stage: { type: 'string', description: 'Preflight stage name' },
    tool: { type: 'string', description: 'Tool or function that failed' },
    classification: { type: 'string', description: 'Diagnostic classification' },
    reason: { type: 'string', description: 'Human-readable reason' },
    'raw-error': { type: 'string', description: 'Captured stderr or exception text' },
    'exit-code': { type: 'string', description: 'Exit code' },
  },
  async run({ args }) {
    const stateDir = String(args['state-dir'] ?? '').trim();
    const stage = String(args.stage ?? '').trim();
    const tool = String(args.tool ?? '').trim();
    const classification = String(args.classification ?? '').trim();
    const reason = String(args.reason ?? '').trim();

    if (!stateDir || !stage || !tool || !classification || !reason) {
      throw new Error('--state-dir, --stage, --tool, --classification, and --reason are required');
    }

    const exitCodeRaw = args['exit-code'];
    const exitCode = exitCodeRaw === undefined ? undefined : Number.parseInt(String(exitCodeRaw), 10);

    await writePreflightDiagnostic(stateDir, {
      stage,
      tool,
      classification: classification as 'preflight-failure' | 'ref-missing' | 'tool-error' | 'config-missing',
      reason,
      rawError: args['raw-error'] ? String(args['raw-error']) : undefined,
      exitCode: Number.isFinite(exitCode) ? exitCode : undefined,
    });
  },
});
