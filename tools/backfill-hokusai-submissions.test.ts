import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const toolSource = readFileSync(join(__dirname, 'backfill-hokusai-submissions.ts'), 'utf-8');

describe('backfill-hokusai-submissions tool', () => {
  it('exposes reviewed promotion manifest workflow flags', () => {
    assert.match(toolSource, /promotion-manifest/);
    assert.match(toolSource, /reviewed\/applied manifest/);
    assert.match(toolSource, /reconciliation report/);
  });

  it('prints machine-readable reconciliation report references', () => {
    assert.match(toolSource, /reconciliationReportHash/);
    assert.match(toolSource, /reconciliationReportPath/);
  });
});
