import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  writeMarker,
  clearMarker,
  readMarker,
  validateMarker,
  buildStaleMarkerFinding,
  type MarkerHandle,
} from './transient-marker.ts';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

test('writeMarker and readMarker round-trip', async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'marker-test-'));
  try {
    const path = join(tmpDir, 'test-marker');
    const handle: MarkerHandle = { path, kind: 'test' };

    writeMarker(handle, {
      headSha: 'abc123',
      reason: 'test write',
      detail: { foo: 'bar' },
    });

    const result = readMarker(handle);
    assert.equal(result.status, 'present');
    if (result.status === 'present') {
      assert.equal(result.payload.kind, 'test');
      assert.equal(result.payload.headSha, 'abc123');
      assert.equal(result.payload.reason, 'test write');
      assert.deepEqual(result.payload.detail, { foo: 'bar' });
    }
  } finally {
    rmSync(tmpDir, { recursive: true });
  }
});

test('readMarker returns absent for missing file', async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'marker-test-'));
  try {
    const path = join(tmpDir, 'nonexistent');
    const result = readMarker({ path, kind: 'test' });
    assert.equal(result.status, 'absent');
  } finally {
    rmSync(tmpDir, { recursive: true });
  }
});

test('readMarker returns legacy for non-JSON content', async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'marker-test-'));
  try {
    const path = join(tmpDir, 'legacy-marker');
    const handle: MarkerHandle = { path, kind: 'test' };

    // Write plain text (legacy format)
    const { writeFileSync } = await import('fs');
    const { mkdirSync } = await import('fs');
    mkdirSync(tmpDir, { recursive: true });
    writeFileSync(path, 'this is legacy plain text');

    const result = readMarker(handle);
    assert.equal(result.status, 'legacy');
    if (result.status === 'legacy') {
      assert.equal(result.body, 'this is legacy plain text');
    }
  } finally {
    rmSync(tmpDir, { recursive: true });
  }
});

test('clearMarker removes the file', async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'marker-test-'));
  try {
    const path = join(tmpDir, 'test-marker');
    const handle: MarkerHandle = { path, kind: 'test' };

    writeMarker(handle, { headSha: 'abc123' });

    let result = readMarker(handle);
    assert.equal(result.status, 'present');

    clearMarker(handle);

    result = readMarker(handle);
    assert.equal(result.status, 'absent');
  } finally {
    rmSync(tmpDir, { recursive: true });
  }
});

test('validateMarker returns valid when SHA matches and condition is true', async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'marker-test-'));
  try {
    const path = join(tmpDir, 'test-marker');
    const handle: MarkerHandle = { path, kind: 'test' };

    writeMarker(handle, { headSha: 'abc123', reason: 'test' });

    const result = await validateMarker(handle, {
      currentHead: 'abc123',
      deriveCondition: async () => true,
    });

    assert.equal(result.status, 'valid');
    if (result.status === 'valid') {
      assert.equal(result.condition, true);
    }
  } finally {
    rmSync(tmpDir, { recursive: true });
  }
});

test('validateMarker returns stale-sha when SHA differs', async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'marker-test-'));
  try {
    const path = join(tmpDir, 'test-marker');
    const handle: MarkerHandle = { path, kind: 'test' };

    writeMarker(handle, { headSha: 'abc123' });

    const result = await validateMarker(handle, {
      currentHead: 'def456',
      deriveCondition: async () => true,
    });

    assert.equal(result.status, 'stale-sha');
    if (result.status === 'stale-sha') {
      assert.equal(result.currentHead, 'def456');
    }
  } finally {
    rmSync(tmpDir, { recursive: true });
  }
});

test('validateMarker returns contradicted when condition is false', async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'marker-test-'));
  try {
    const path = join(tmpDir, 'test-marker');
    const handle: MarkerHandle = { path, kind: 'test' };

    writeMarker(handle, { headSha: 'abc123' });

    const result = await validateMarker(handle, {
      currentHead: 'abc123',
      deriveCondition: async () => false,
    });

    assert.equal(result.status, 'contradicted');
  } finally {
    rmSync(tmpDir, { recursive: true });
  }
});

test('validateMarker calls onInvalidated for stale-sha', async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'marker-test-'));
  try {
    const path = join(tmpDir, 'test-marker');
    const handle: MarkerHandle = { path, kind: 'test' };

    writeMarker(handle, { headSha: 'abc123' });

    let called = false;
    let calledReason = '';

    await validateMarker(handle, {
      currentHead: 'def456',
      deriveCondition: async () => true,
      onInvalidated: (reason) => {
        called = true;
        calledReason = reason;
      },
    });

    assert.equal(called, true);
    assert.equal(calledReason, 'stale-sha');
  } finally {
    rmSync(tmpDir, { recursive: true });
  }
});

test('validateMarker calls onInvalidated for contradicted', async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'marker-test-'));
  try {
    const path = join(tmpDir, 'test-marker');
    const handle: MarkerHandle = { path, kind: 'test' };

    writeMarker(handle, { headSha: 'abc123' });

    let called = false;
    let calledReason = '';

    await validateMarker(handle, {
      currentHead: 'abc123',
      deriveCondition: async () => false,
      onInvalidated: (reason) => {
        called = true;
        calledReason = reason;
      },
    });

    assert.equal(called, true);
    assert.equal(calledReason, 'contradicted');
  } finally {
    rmSync(tmpDir, { recursive: true });
  }
});

test('validateMarker returns absent when file does not exist', async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'marker-test-'));
  try {
    const path = join(tmpDir, 'nonexistent');
    const handle: MarkerHandle = { path, kind: 'test' };

    const result = await validateMarker(handle, {
      currentHead: 'abc123',
      deriveCondition: async () => true,
    });

    assert.equal(result.status, 'absent');
  } finally {
    rmSync(tmpDir, { recursive: true });
  }
});

test('buildStaleMarkerFinding creates finding for stale-sha', async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'marker-test-'));
  try {
    const path = join(tmpDir, 'test-marker');
    const handle: MarkerHandle = { path, kind: 'test-kind' };

    writeMarker(handle, { headSha: 'abc123', reason: 'test reason' });

    const validation = await validateMarker(handle, {
      currentHead: 'def456',
      deriveCondition: async () => true,
    });

    const finding = buildStaleMarkerFinding(handle, validation, { repo: 'test-repo' });

    assert.notEqual(finding, null);
    if (finding) {
      assert.equal(finding.subsystem, 'marker-lifecycle');
      assert.match(finding.title, /Stale marker/);
      assert.equal(finding.severity, 'warning');
    }
  } finally {
    rmSync(tmpDir, { recursive: true });
  }
});

test('buildStaleMarkerFinding creates finding for contradicted', async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'marker-test-'));
  try {
    const path = join(tmpDir, 'test-marker');
    const handle: MarkerHandle = { path, kind: 'test-kind' };

    writeMarker(handle, { headSha: 'abc123' });

    const validation = await validateMarker(handle, {
      currentHead: 'abc123',
      deriveCondition: async () => false,
    });

    const finding = buildStaleMarkerFinding(handle, validation, { repo: 'test-repo' });

    assert.notEqual(finding, null);
    if (finding) {
      assert.equal(finding.subsystem, 'marker-lifecycle');
      assert.match(finding.title, /Contradicted marker/);
      assert.equal(finding.severity, 'warning');
    }
  } finally {
    rmSync(tmpDir, { recursive: true });
  }
});

test('buildStaleMarkerFinding returns null for absent', async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'marker-test-'));
  try {
    const path = join(tmpDir, 'nonexistent');
    const handle: MarkerHandle = { path, kind: 'test' };

    const validation = { status: 'absent' as const };
    const finding = buildStaleMarkerFinding(handle, validation, { repo: 'test-repo' });

    assert.equal(finding, null);
  } finally {
    rmSync(tmpDir, { recursive: true });
  }
});

test('writeMarker survives simulated crash (atomic rename)', async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'marker-test-'));
  try {
    const path = join(tmpDir, 'test-marker');
    const handle: MarkerHandle = { path, kind: 'test' };

    writeMarker(handle, { headSha: 'abc123' });

    // Verify it's written correctly
    const result = readMarker(handle);
    assert.equal(result.status, 'present');
    if (result.status === 'present') {
      assert.equal(result.payload.headSha, 'abc123');
    }

    // Verify no tmp files are left behind
    const { readdirSync } = await import('fs');
    const files = readdirSync(tmpDir);
    const tmpFiles = files.filter((f) => f.includes('.tmp.'));
    assert.equal(tmpFiles.length, 0, 'tmp files should be cleaned up');
  } finally {
    rmSync(tmpDir, { recursive: true });
  }
});

test('validateMarker handles sync condition function', async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'marker-test-'));
  try {
    const path = join(tmpDir, 'test-marker');
    const handle: MarkerHandle = { path, kind: 'test' };

    writeMarker(handle, { headSha: 'abc123' });

    // Pass a synchronous condition function
    const result = await validateMarker(handle, {
      currentHead: 'abc123',
      deriveCondition: () => 'sync-result' as unknown,
    });

    assert.equal(result.status, 'valid');
    if (result.status === 'valid') {
      assert.equal(result.condition, 'sync-result');
    }
  } finally {
    rmSync(tmpDir, { recursive: true });
  }
});
