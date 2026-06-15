import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, beforeEach, describe, it } from 'node:test';
import { clearConfigCache } from './config.ts';
import { saveUserConfig } from './hokusai-consent.ts';
import { drainContributionQueue } from './hokusai-queue-drain.ts';
import { enqueueContribution, hokusaiQueueStatus } from './hokusai-queue.ts';
import { TECHNICAL_TASK_ROUTER_ROW_SCHEMA_VERSION_V2, TECHNICAL_TASK_ROUTER_BENCHMARK_SPEC_ID_V2 } from './hokusai-contribution-schema.ts';

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function makeRepo(withExportPath: boolean): { repoDir: string; configDir: string; exportDir: string } {
  const repoDir = makeTempDir('hokusai-export-repo-');
  const configDir = makeTempDir('hokusai-export-config-');
  const exportDir = makeTempDir('hokusai-export-dir-');
  writeFileSync(join(repoDir, '.wavemill-config.json'), `${JSON.stringify({
    hokusai: {
      dataSubmission: { consentVersion: '1.0' },
      contributions: {
        enabled: true,
        endpoint: null,
        exportPath: withExportPath ? exportDir : null,
      },
    },
  }, null, 2)}\n`);
  saveUserConfig({
    hokusai: {
      enabled: true,
      consentedAt: '2026-05-30T12:00:00.000Z',
      consentVersion: '1.0',
    },
  }, configDir);
  return { repoDir, configDir, exportDir };
}

after(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

beforeEach(() => {
  clearConfigCache();
});

describe('hokusai-queue-export', () => {
  it('exports pending rows when endpoint is unconfigured and exportPath is set', async () => {
    const { repoDir, configDir, exportDir } = makeRepo(true);
    await enqueueContribution({ success_under_budget: true, task_id: 'a' }, { repoDir, configDir });
    await enqueueContribution({ success_under_budget: false, task_id: 'b' }, { repoDir, configDir });

    const result = await drainContributionQueue({
      repoDir,
      configDir,
      now: new Date('2026-05-31T12:00:00.000Z'),
    });

    assert.equal(result.status, 'exported');
    assert.equal(result.exportedCount, 2);
    const exportPath = join(exportDir, 'contributions-2026-05-31.jsonl');
    assert.equal(readFileSync(exportPath, 'utf-8').trim().split('\n').length, 2);
    assert.equal(hokusaiQueueStatus({ repoDir, configDir }).processedLineCount, 0);
    assert.equal(hokusaiQueueStatus({ repoDir, configDir }).exportLineCount, 2);
  });

  it('returns unconfigured when neither endpoint nor exportPath is set', async () => {
    const { repoDir, configDir } = makeRepo(false);
    await enqueueContribution({ success_under_budget: true, task_id: 'a' }, { repoDir, configDir });

    const result = await drainContributionQueue({ repoDir, configDir });

    assert.equal(result.status, 'unconfigured');
    assert.equal(hokusaiQueueStatus({ repoDir, configDir }).pendingCount, 1);
  });

  it('appends safely on repeated same-day exports without marking accepted', async () => {
    const { repoDir, configDir, exportDir } = makeRepo(true);
    const now = new Date('2026-05-31T12:00:00.000Z');
    await enqueueContribution({ success_under_budget: true, task_id: 'a' }, { repoDir, configDir });
    await drainContributionQueue({ repoDir, configDir, now });
    await enqueueContribution({ success_under_budget: true, task_id: 'b' }, { repoDir, configDir });
    await drainContributionQueue({ repoDir, configDir, now });

    const exportPath = join(exportDir, 'contributions-2026-05-31.jsonl');
    assert.equal(readFileSync(exportPath, 'utf-8').trim().split('\n').length, 2);
    assert.equal(hokusaiQueueStatus({ repoDir, configDir }).processedLineCount, 0);
  });

  it('enqueues and exports v2 rows', async () => {
    const { repoDir, configDir, exportDir } = makeRepo(true);
    const v2Row = {
      schema_version: TECHNICAL_TASK_ROUTER_ROW_SCHEMA_VERSION_V2,
      row_id: 'test-v2-row-001',
      benchmark_spec_id: TECHNICAL_TASK_ROUTER_BENCHMARK_SPEC_ID_V2,
      eval_id: 'test-eval-001',
      model_id: 'test-model-001',
      scenario: 'production_pool',
      candidate_pool_id: 'test-pool-001',
      task_descriptor: { task_type: 'feature', domain: 'backend' },
      allowed_models: ['model-a', 'model-b'],
      selected_models: ['model-a'],
      max_cost_usd: 0.1,
      actual_cost_usd: 0.05,
      completed_successfully: true,
      scorer_ref: TECHNICAL_TASK_ROUTER_BENCHMARK_SPEC_ID_V2,
      observed_at: '2026-06-15T00:00:00Z',
    };

    await enqueueContribution(v2Row, { repoDir, configDir });

    const status = hokusaiQueueStatus({ repoDir, configDir });
    assert.equal(status.pendingCount, 1);

    const result = await drainContributionQueue({
      repoDir,
      configDir,
      now: new Date('2026-06-15T12:00:00.000Z'),
    });

    assert.equal(result.status, 'exported');
    assert.equal(result.exportedCount, 1);
    const exportPath = join(exportDir, 'contributions-2026-06-15.jsonl');
    const lines = readFileSync(exportPath, 'utf-8').trim().split('\n');
    assert.equal(lines.length, 1);

    const exported = JSON.parse(lines[0]);
    assert.equal(exported.schema_version, TECHNICAL_TASK_ROUTER_ROW_SCHEMA_VERSION_V2);
    assert.equal(exported.row_id, 'test-v2-row-001');
  });

  it('enqueues v1 and v2 rows together and exports both', async () => {
    const { repoDir, configDir, exportDir } = makeRepo(true);
    const now = new Date('2026-06-15T12:00:00.000Z');

    const v1Row = { success_under_budget: true, task_id: 'v1-task' };
    const v2Row = {
      schema_version: TECHNICAL_TASK_ROUTER_ROW_SCHEMA_VERSION_V2,
      row_id: 'v2-row-001',
      benchmark_spec_id: TECHNICAL_TASK_ROUTER_BENCHMARK_SPEC_ID_V2,
      eval_id: 'eval-001',
      model_id: 'model-001',
      scenario: 'production_pool',
      candidate_pool_id: 'pool-001',
      task_descriptor: { task_type: 'feature' },
      allowed_models: ['model-a'],
      selected_models: ['model-a'],
      max_cost_usd: 0.1,
      actual_cost_usd: 0.05,
      completed_successfully: true,
      scorer_ref: TECHNICAL_TASK_ROUTER_BENCHMARK_SPEC_ID_V2,
      observed_at: '2026-06-15T00:00:00Z',
    };

    await enqueueContribution(v1Row, { repoDir, configDir });
    await enqueueContribution(v2Row, { repoDir, configDir });

    const result = await drainContributionQueue({ repoDir, configDir, now });

    assert.equal(result.status, 'exported');
    assert.equal(result.exportedCount, 2);
    const exportPath = join(exportDir, 'contributions-2026-06-15.jsonl');
    const lines = readFileSync(exportPath, 'utf-8').trim().split('\n');
    assert.equal(lines.length, 2);

    const rows = lines.map((line) => JSON.parse(line));
    assert(rows.some((r) => r.success_under_budget !== undefined));
    assert(rows.some((r) => r.schema_version === TECHNICAL_TASK_ROUTER_ROW_SCHEMA_VERSION_V2));
  });
});
