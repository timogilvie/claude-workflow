import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { appendJsonlRecord, readJsonlFile, readTransformWrite } from './jsonl-utils.ts';

let tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  tempDirs = [];
});

function makeTempFile(contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'jsonl-utils-'));
  tempDirs.push(dir);
  const filePath = join(dir, 'records.jsonl');
  writeFileSync(filePath, contents, 'utf-8');
  return filePath;
}

describe('readJsonlFile', () => {
  it('skips malformed and blank lines', () => {
    const filePath = makeTempFile('{"a":1}\nnot json\n\n{"a":2}\n');
    assert.deepEqual(readJsonlFile<{ a: number }>(filePath), [{ a: 1 }, { a: 2 }]);
  });
});

describe('appendJsonlRecord', () => {
  it('creates the file and parent directory when missing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'jsonl-utils-'));
    tempDirs.push(dir);
    const filePath = join(dir, 'nested', 'records.jsonl');

    appendJsonlRecord(filePath, { id: 1 });

    assert.equal(existsSync(filePath), true);
    assert.equal(readFileSync(filePath, 'utf-8'), '{"id":1}\n');
  });

  it('appends valid JSONL lines', () => {
    const filePath = makeTempFile('{"id":1}\n');

    appendJsonlRecord(filePath, { id: 2 });

    assert.equal(readFileSync(filePath, 'utf-8'), '{"id":1}\n{"id":2}\n');
  });

  it('accumulates multiple appends', () => {
    const filePath = makeTempFile('');

    appendJsonlRecord(filePath, { id: 1 });
    appendJsonlRecord(filePath, { id: 2 });
    appendJsonlRecord(filePath, { id: 3 });

    assert.deepEqual(readJsonlFile<{ id: number }>(filePath), [
      { id: 1 },
      { id: 2 },
      { id: 3 },
    ]);
  });

  it('leaves valid JSONL after append', () => {
    const filePath = makeTempFile('{"id":1}\n');

    appendJsonlRecord(filePath, { id: 2, nested: { ok: true } });

    assert.deepEqual(
      readJsonlFile<{ id: number; nested?: { ok: boolean } }>(filePath),
      [{ id: 1 }, { id: 2, nested: { ok: true } }],
    );
  });

  it('handles an empty existing file', () => {
    const filePath = makeTempFile('');

    appendJsonlRecord(filePath, { id: 1 });

    assert.equal(readFileSync(filePath, 'utf-8'), '{"id":1}\n');
  });
});

describe('readTransformWrite', () => {
  it('rewrites only changed records and preserves malformed lines', () => {
    const filePath = makeTempFile('{"id":1,"ok":false}\nbad line\n{"id":2,"ok":true}\n');

    const summary = readTransformWrite<{ id: number; ok: boolean }>(filePath, (record) => ({
      record: record.id === 1 ? { ...record, ok: true } : record,
      changed: record.id === 1,
    }));

    assert.deepEqual(summary, {
      recordsProcessed: 2,
      recordsChanged: 1,
      malformedLines: 1,
      fileModified: true,
    });
    assert.equal(
      readFileSync(filePath, 'utf-8'),
      '{"id":1,"ok":true}\nbad line\n{"id":2,"ok":true}\n',
    );
    assert.equal(
      readFileSync(`${filePath}.backup`, 'utf-8'),
      '{"id":1,"ok":false}\nbad line\n{"id":2,"ok":true}\n',
    );
  });

  it('does not write files during dry run', () => {
    const filePath = makeTempFile('{"id":1}\n');

    const summary = readTransformWrite<{ id: number; done?: boolean }>(
      filePath,
      (record) => ({ record: { ...record, done: true }, changed: true }),
      { dryRun: true },
    );

    assert.equal(summary.fileModified, true);
    assert.equal(readFileSync(filePath, 'utf-8'), '{"id":1}\n');
    assert.equal(existsSync(`${filePath}.backup`), false);
  });

  it('does not create backups when nothing changes', () => {
    const filePath = makeTempFile('{"id":1}\n');

    const summary = readTransformWrite<{ id: number }>(filePath, (record) => ({
      record,
      changed: false,
    }));

    assert.equal(summary.fileModified, false);
    assert.equal(existsSync(`${filePath}.backup`), false);
  });
});
