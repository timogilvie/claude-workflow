import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, beforeEach, describe, it } from 'node:test';
import { clearConfigCache } from './config.ts';
import { saveUserConfig } from './hokusai-consent.ts';
import { drainContributionQueue } from './hokusai-queue-drain.ts';
import { enqueueContribution, hokusaiQueueStatus } from './hokusai-queue.ts';

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
});
