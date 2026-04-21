#!/usr/bin/env -S npx tsx
import { runTool } from '../shared/lib/tool-runner.ts';
import { resolveEvalsDir } from '../shared/lib/evals-paths.ts';
import { readTransformWrite } from '../shared/lib/jsonl-utils.ts';
import { getManifestRef } from '../shared/lib/resource-manifest.ts';

runTool({
  name: 'backfill-manifest-refs',
  description: 'Best-effort backfill of manifestRef on historical eval records',
  options: {
    'repo-dir': { type: 'string', description: 'Repository directory override' },
    'dry-run': { type: 'boolean', description: 'Report changes without writing them' },
  },
  async run({ args }) {
    const repoDir = args['repo-dir'] as string | undefined;
    const evalsPath = `${resolveEvalsDir(undefined, repoDir).dir}/evals.jsonl`;
    const summary = readTransformWrite<Record<string, unknown>>(evalsPath, (record) => {
      const metadata = record.metadata as Record<string, unknown> | undefined;
      const sessionId = (record as any).sessionId || (metadata?.sessionId as string | undefined);
      if (!sessionId || (record as any).manifestRef) {
        return { record, changed: false };
      }
      const manifestRef = getManifestRef(sessionId, repoDir);
      if (!manifestRef) {
        return { record, changed: false };
      }
      return {
        record: {
          ...record,
          manifestRef,
        },
        changed: true,
      };
    }, { dryRun: Boolean(args['dry-run']) });

    console.log(JSON.stringify(summary, null, 2));
  },
});
