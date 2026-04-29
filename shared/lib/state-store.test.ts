import assert from 'node:assert/strict';
import test from 'node:test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { spawn } from 'node:child_process';
import {
  getValue,
  initIfMissing,
  runJqLocked,
  atomicWriteJson,
  withFileLock,
  LOCK_TIMEOUT_EXIT_CODE,
} from './state-store.ts';

const TOOLS_DIR = path.join(process.cwd(), 'tools');

async function createTempFile(): Promise<string> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'state-test-'));
  return path.join(tmpDir, 'test-state.json');
}

async function cleanup(filePath: string) {
  const dir = path.dirname(filePath);
  try {
    await fs.rm(dir, { recursive: true, force: true });
  } catch {
    // Ignore cleanup errors
  }
}

test('Sequential CRUD round-trip produces correct values', async () => {
  const testFile = await createTempFile();

  try {
    // Initialize
    await initIfMissing(testFile, { tasks: {}, counter: 0 });
    let value = await getValue(testFile, '.');
    assert.deepEqual(value, { tasks: {}, counter: 0 });

    // Set a task
    await runJqLocked(
      testFile,
      '.tasks[$issue] = {status: $status, updated: (now | todate)}',
      ['--arg', 'issue', 'HOK-123', '--arg', 'status', 'active']
    );
    value = await getValue(testFile, '.tasks["HOK-123"].status');
    assert.equal(value, 'active');

    // Update counter
    await runJqLocked(testFile, '.counter = .counter + 1');
    value = await getValue(testFile, '.counter');
    assert.equal(value, 1);

    // Delete task
    await runJqLocked(testFile, 'del(.tasks["HOK-123"])');
    value = await getValue(testFile, '.tasks["HOK-123"]');
    assert.equal(value, null);

    // Counter should still be there
    value = await getValue(testFile, '.counter');
    assert.equal(value, 1);
  } finally {
    await cleanup(testFile);
  }
});

test('Atomic write uses temp file and rename', async () => {
  const testFile = await createTempFile();

  try {
    const testData = { foo: 'bar', nested: { value: 42 } };

    // Write atomically
    await atomicWriteJson(testFile, testData);

    // Verify content
    const content = await fs.readFile(testFile, 'utf-8');
    const parsed = JSON.parse(content);
    assert.deepEqual(parsed, testData);

    // Verify no temp files left behind
    const dir = path.dirname(testFile);
    const files = await fs.readdir(dir);
    assert.equal(files.filter(f => f.startsWith('.tmp-state-')).length, 0);
  } finally {
    await cleanup(testFile);
  }
});

test('Atomic write is crash-safe (original file protected)', async () => {
  const testFile = await createTempFile();
  const dir = path.dirname(testFile);

  try {
    const originalData = { version: 1, data: 'original' };
    await atomicWriteJson(testFile, originalData);

    // Simulate a crash by:
    // 1. Create a temp file manually (like atomicWriteJson would)
    // 2. Verify that if we crash here, the original is still intact
    const tempFile = path.join(dir, `.tmp-state-${Math.random()}.json`);
    const newData = { version: 2, data: 'new' };
    await fs.writeFile(tempFile, JSON.stringify(newData));

    // At this point, temp file exists but original is intact
    // Verify original file is still readable and correct
    const originalContent = await fs.readFile(testFile, 'utf-8');
    const originalParsed = JSON.parse(originalContent);
    assert.deepEqual(originalParsed, originalData,
      'Original file should be unchanged if crash occurs before rename');

    // Now complete the atomic write
    await atomicWriteJson(testFile, newData);

    // Verify new data is now present
    const newContent = await fs.readFile(testFile, 'utf-8');
    const newParsed = JSON.parse(newContent);
    assert.deepEqual(newParsed, newData);

    // Verify no temp files left
    const files = await fs.readdir(dir);
    assert.equal(files.filter(f => f.startsWith('.tmp-state-')).length, 0);
  } finally {
    // Clean up any temp files
    try {
      const files = await fs.readdir(dir);
      for (const file of files) {
        if (file.startsWith('.tmp-state-')) {
          await fs.unlink(path.join(dir, file));
        }
      }
    } catch {
      // Ignore cleanup errors
    }
    await cleanup(testFile);
  }
});

test('Concurrent writers - no lost updates', async () => {
  const testFile = await createTempFile();

  try {
    // Initialize counter
    await initIfMissing(testFile, { counter: 0 });

    // Spawn 8 workers, each performing 10 sequential increments (80 total)
    const numWorkers = 8;
    const incrementsPerWorker = 10;

    function spawnWorker(workerId: number, remaining: number): Promise<void> {
      if (remaining === 0) return Promise.resolve();

      return new Promise<void>((resolve, reject) => {
        const child = spawn('npx', [
          'tsx',
          path.join(TOOLS_DIR, 'state.ts'),
          'set',
          testFile,
          '--',
          '.counter = (.counter // 0) + 1',
        ], {
          stdio: ['ignore', 'pipe', 'pipe']
        });

        let stderr = '';
        child.stderr?.on('data', (data) => {
          stderr += data.toString();
        });

        child.on('exit', (code) => {
          if (code === 0) {
            spawnWorker(workerId, remaining - 1).then(resolve, reject);
          } else {
            reject(new Error(`Worker ${workerId} iteration failed: ${stderr}`));
          }
        });

        child.on('error', reject);
      });
    }

    // Launch all workers in parallel (they will serialize within via locking)
    const workers = [];
    for (let w = 0; w < numWorkers; w++) {
      workers.push(spawnWorker(w, incrementsPerWorker));
    }

    await Promise.all(workers);

    // Verify final counter value
    const finalValue = await getValue(testFile, '.counter');
    const expectedTotal = numWorkers * incrementsPerWorker;
    assert.equal(finalValue, expectedTotal,
      `Expected counter to be ${expectedTotal} but got ${finalValue}`);
  } finally {
    await cleanup(testFile);
  }
});

test('Lock timeout when lock is held', async (t) => {
  const testFile = await createTempFile();
  const lockFile = `${testFile}.lock`;

  try {
    // Create and hold a lock manually
    await fs.writeFile(lockFile, `${process.pid}\n${os.hostname()}\n${Date.now()}\n`);

    // Try to acquire lock with short timeout
    await assert.rejects(
      async () => {
        await withFileLock(testFile, async () => {
          return 'should not get here';
        }, { timeout: 500 }); // 500ms timeout
      },
      {
        code: 'LOCK_TIMEOUT',
      }
    );
  } finally {
    // Clean up lock
    try {
      await fs.unlink(lockFile);
    } catch {
      // Ignore
    }
    await cleanup(testFile);
  }
});

test('Stale lock reclamation with dead PID', async () => {
  const testFile = await createTempFile();
  const lockFile = `${testFile}.lock`;

  try {
    // Create a stale lock with a very high (likely non-existent) PID
    // and timestamp older than 30 seconds
    const stalePid = 9999999;
    const staleTimestamp = Date.now() - 35000; // 35 seconds ago

    await fs.writeFile(lockFile, `${stalePid}\n${os.hostname()}\n${staleTimestamp}\n`);

    // Should be able to acquire lock despite existing lock file
    await initIfMissing(testFile, { reclaimed: true });

    const value = await getValue(testFile, '.reclaimed');
    assert.equal(value, true);

    // Lock file should have been cleaned up after the operation
    // (withFileLock releases the lock when done)
    try {
      await fs.stat(lockFile);
      assert.fail('Lock file should have been cleaned up');
    } catch (err: unknown) {
      const error = err as NodeJS.ErrnoException;
      assert.equal(error.code, 'ENOENT');
    }
  } finally {
    try {
      await fs.unlink(lockFile);
    } catch {
      // Ignore
    }
    await cleanup(testFile);
  }
});

test('getValue returns null for non-existent file', async () => {
  const testFile = '/tmp/nonexistent-' + Math.random() + '.json';
  const value = await getValue(testFile, '.foo');
  assert.equal(value, null);
});

test('initIfMissing creates file only if missing', async () => {
  const testFile = await createTempFile();

  try {
    // First init
    await initIfMissing(testFile, { initial: true });
    let value = await getValue(testFile, '.initial');
    assert.equal(value, true);

    // Second init should not overwrite
    await initIfMissing(testFile, { initial: false, new: true });
    value = await getValue(testFile, '.');
    assert.deepEqual(value, { initial: true }); // Should still have initial value
    assert.equal(await getValue(testFile, '.new'), null);
  } finally {
    await cleanup(testFile);
  }
});

test('runJqLocked handles complex jq expressions', async () => {
  const testFile = await createTempFile();

  try {
    await initIfMissing(testFile, { tasks: {} });

    // Complex nested update
    await runJqLocked(
      testFile,
      '.tasks[$issue] = (.tasks[$issue] // {}) + {status: $status, metadata: {updated: (now | todate), agent: $agent}}',
      [
        '--arg', 'issue', 'HOK-456',
        '--arg', 'status', 'in-progress',
        '--arg', 'agent', 'claude'
      ]
    );

    const task = await getValue(testFile, '.tasks["HOK-456"]');
    assert.equal(typeof task, 'object');
    assert.ok(task !== null);
    const taskObj = task as Record<string, unknown>;
    assert.equal(taskObj.status, 'in-progress');
    assert.equal(typeof taskObj.metadata, 'object');
  } finally {
    await cleanup(testFile);
  }
});
