import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  CERTIFICATION_SCHEMA_VERSION,
  type CertificationSubject,
  type NativeCertificationArtifact,
} from './schema.ts';
import {
  listCertifications,
  listGlobalCertificationSuiteVersions,
  listScopedCertifications,
  readCertification,
  serializeCertification,
  writeCertification,
  validateCertificationForWrite,
  writeScopedCertification,
} from './store.ts';
import { GLOBAL_CERTIFICATION_ROOT_ENV, buildScopedCertificationPath } from './storage.ts';

const FIXTURE_DIR = new URL('./fixtures', import.meta.url).pathname;
const VALID_SUBJECT: CertificationSubject = {
  registryKey: 'claude-sonnet-4-6',
  nativeProvider: 'anthropic',
  providerId: 'anthropic',
  providerModelId: 'claude-sonnet-4-6',
  providerNativeId: 'claude-sonnet-4-6',
  identityRevision: 1,
  identityFingerprint: 'test-fingerprint',
  catalogHash: 'registry',
};

function loadFixture(name: string): unknown {
  return JSON.parse(readFileSync(join(FIXTURE_DIR, name), 'utf-8'));
}

function makeValidArtifact(overrides: Partial<NativeCertificationArtifact> = {}): NativeCertificationArtifact {
  const provider = overrides.provider ?? 'anthropic';
  const model = overrides.model ?? 'claude-sonnet-4-6';
  return {
    schemaVersion: CERTIFICATION_SCHEMA_VERSION,
    subject: overrides.subject ?? subjectFor(provider, model),
    provider,
    model,
    phase: 'read-only',
    suiteVersion: 'v1',
    certifiedAt: '2026-06-01T00:00:00.000Z',
    scenarios: [{ scenarioId: 'list-files', passed: true }],
    ...overrides,
  };
}

function subjectFor(provider: string, model: string): CertificationSubject {
  return {
    ...VALID_SUBJECT,
    registryKey: model,
    nativeProvider: provider,
    providerId: provider,
    providerModelId: model,
    providerNativeId: model,
  };
}

function makeTempRepo(): string {
  return mkdtempSync(join(tmpdir(), 'native-cert-store-test-'));
}

function cleanupRepo(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

function withIsolatedGlobalCertificationRoot<T>(fn: (root: string) => T): T {
  const root = mkdtempSync(join(tmpdir(), 'native-cert-global-test-'));
  const previous = process.env[GLOBAL_CERTIFICATION_ROOT_ENV];
  process.env[GLOBAL_CERTIFICATION_ROOT_ENV] = root;
  try {
    return fn(root);
  } finally {
    if (previous === undefined) {
      delete process.env[GLOBAL_CERTIFICATION_ROOT_ENV];
    } else {
      process.env[GLOBAL_CERTIFICATION_ROOT_ENV] = previous;
    }
    rmSync(root, { recursive: true, force: true });
  }
}

// ─── serializeCertification ────────────────────────────────────────────────

describe('serializeCertification', () => {
  it('produces trailing newline', () => {
    const artifact = makeValidArtifact();
    const serialized = serializeCertification(artifact);
    assert.equal(serialized[serialized.length - 1], '\n');
  });

  it('sorts top-level keys alphabetically', () => {
    const artifact = makeValidArtifact();
    const serialized = serializeCertification(artifact);
    const parsed = JSON.parse(serialized) as Record<string, unknown>;
    const keys = Object.keys(parsed);
    assert.deepEqual(keys, [...keys].sort());
  });

  it('sorts nested object keys alphabetically', () => {
    const artifact = makeValidArtifact({
      scenarios: [{ scenarioId: 'list-files', passed: true, retryCount: 0, failureMessage: undefined }],
    });
    const serialized = serializeCertification(artifact);
    const parsed = JSON.parse(serialized) as NativeCertificationArtifact;
    const scenarioKeys = Object.keys(parsed.scenarios[0]);
    assert.deepEqual(scenarioKeys, [...scenarioKeys].sort());
  });

  it('certifiedAt appears before model in sorted output', () => {
    const artifact = makeValidArtifact();
    const serialized = serializeCertification(artifact);
    const parsed = JSON.parse(serialized) as Record<string, unknown>;
    const keys = Object.keys(parsed);
    assert.ok(keys.indexOf('certifiedAt') < keys.indexOf('model'));
  });

  it('produces stable output for valid-read-only fixture', () => {
    const raw = loadFixture('valid-read-only.json') as NativeCertificationArtifact;
    const once = serializeCertification(raw);
    const twice = serializeCertification(raw);
    assert.equal(once, twice);
  });
});

// ─── writeCertification ────────────────────────────────────────────────────

describe('writeCertification', () => {
  it('round-trips: written artifact reads back with matching fields', () => {
    const repoDir = makeTempRepo();
    try {
      const artifact = makeValidArtifact();
      const path = writeCertification(repoDir, artifact);
      const result = readCertification(path);
      assert.ok(result.ok);
      if (result.ok) {
        assert.equal(result.artifact.provider, artifact.provider);
        assert.equal(result.artifact.model, artifact.model);
        assert.equal(result.artifact.phase, artifact.phase);
        assert.equal(result.artifact.suiteVersion, artifact.suiteVersion);
        assert.equal(result.artifact.certifiedAt, artifact.certifiedAt);
        assert.deepEqual(result.artifact.scenarios, artifact.scenarios);
      }
    } finally {
      cleanupRepo(repoDir);
    }
  });

  it('produces byte-identical output when written twice', () => {
    const repoDir = makeTempRepo();
    try {
      const artifact = makeValidArtifact();
      const path = writeCertification(repoDir, artifact);
      const first = readFileSync(path, 'utf-8');
      writeCertification(repoDir, artifact);
      const second = readFileSync(path, 'utf-8');
      assert.equal(first, second);
    } finally {
      cleanupRepo(repoDir);
    }
  });

  it('leaves no .tmp-* files after successful write', () => {
    const repoDir = makeTempRepo();
    try {
      const artifact = makeValidArtifact();
      const path = writeCertification(repoDir, artifact);
      const dir = path.substring(0, path.lastIndexOf('/'));
      const entries = readdirSync(dir);
      const tmpFiles = entries.filter(e => e.includes('.tmp-'));
      assert.equal(tmpFiles.length, 0);
    } finally {
      cleanupRepo(repoDir);
    }
  });

  it('replaces existing artifact fully when written twice with different content', () => {
    const repoDir = makeTempRepo();
    try {
      const first = makeValidArtifact({ scenarios: [{ scenarioId: 'first', passed: true }] });
      const second = makeValidArtifact({ scenarios: [{ scenarioId: 'second', passed: true }] });

      writeCertification(repoDir, first);
      const path = writeCertification(repoDir, second);

      const result = readCertification(path);
      assert.ok(result.ok);
      if (result.ok) {
        assert.deepEqual(result.artifact.scenarios, [{ scenarioId: 'second', passed: true }]);
      }
    } finally {
      cleanupRepo(repoDir);
    }
  });

  it('throws when record is missing required field (write-side schema rejection)', () => {
    const repoDir = makeTempRepo();
    try {
      const bad = { ...makeValidArtifact() } as Record<string, unknown>;
      delete bad['provider'];
      assert.throws(
        () => writeCertification(repoDir, bad as NativeCertificationArtifact),
        /schema validation/,
      );
    } finally {
      cleanupRepo(repoDir);
    }
  });

  it('throws before write when artifact identity is not canonical', () => {
    const repoDir = makeTempRepo();
    try {
      const bad = makeValidArtifact({ provider: 'openrouter', model: 'qwen-3-coder', suiteVersion: 'v2' });
      assert.throws(() => writeCertification(repoDir, bad), /canonical storage identity qwen\/qwen3-coder/);
    } finally {
      cleanupRepo(repoDir);
    }
  });

  it('throws before write when known limitations contain local paths or secrets', () => {
    const artifact = makeValidArtifact({
      knownLimitations: ['debug log at /Users/example/project with API_KEY present'],
    });
    assert.throws(() => validateCertificationForWrite(artifact), /secrets or local paths/);
  });

  it('throws before write when certifiedAt is implausibly old or in the future', () => {
    assert.throws(
      () => validateCertificationForWrite(makeValidArtifact({ certifiedAt: '2020-01-01T00:00:00.000Z' })),
      /outside the accepted publication window/,
    );
    assert.throws(
      () => validateCertificationForWrite(makeValidArtifact({ certifiedAt: '2999-01-01T00:00:00.000Z' })),
      /outside the accepted publication window/,
    );
  });

  it('throws when provider contains path traversal characters', () => {
    const repoDir = makeTempRepo();
    try {
      // buildCertificationPath throws on invalid segments, but schema validation
      // rejects the artifact first (provider must be non-empty string min 1)
      // Use '..' which is a valid string but rejected by isValidPathSegment
      const bad = makeValidArtifact({ provider: '..' });
      assert.throws(() => writeCertification(repoDir, bad));
    } finally {
      cleanupRepo(repoDir);
    }
  });

  it('creates parent directories automatically', () => {
    const repoDir = makeTempRepo();
    try {
      const artifact = makeValidArtifact({ provider: 'openai', model: 'gpt-4o', suiteVersion: 'v2' });
      const path = writeCertification(repoDir, artifact);
      assert.ok(path.includes('openai/gpt-4o/v2.json'));
      const result = readCertification(path);
      assert.ok(result.ok);
    } finally {
      cleanupRepo(repoDir);
    }
  });
});

describe('listGlobalCertificationSuiteVersions', () => {
  it('counts suite versions from global artifact paths without reading files', () => {
    withIsolatedGlobalCertificationRoot((root) => {
      for (const rel of [
        'openai/gpt-4o/v3.json',
        'openrouter/qwen3-coder/v3.json',
        'openrouter/glm-5.2/v2.json',
        'openrouter/glm-5.2/not-json.txt',
      ]) {
        const path = join(root, rel);
        mkdirSync(path.substring(0, path.lastIndexOf('/')), { recursive: true });
        writeFileSync(path, '{}', { flag: 'w' });
      }

      assert.deepEqual(listGlobalCertificationSuiteVersions(), { v2: 1, v3: 2 });
    });
  });
});

// ─── readCertification ────────────────────────────────────────────────────

describe('readCertification', () => {
  it('returns not-found for a path that does not exist', () => {
    const repoDir = makeTempRepo();
    try {
      const result = readCertification(join(repoDir, 'nonexistent.json'));
      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.equal(result.error.code, 'not-found');
        assert.ok(result.error.message.includes('nonexistent.json'));
        assert.ok(result.error.path.includes('nonexistent.json'));
      }
    } finally {
      cleanupRepo(repoDir);
    }
  });

  it('returns invalid-json for a file containing broken JSON', () => {
    const repoDir = makeTempRepo();
    try {
      const p = join(repoDir, 'broken.json');
      writeFileSync(p, '{ broken json', 'utf-8');
      const result = readCertification(p);
      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.equal(result.error.code, 'invalid-json');
      }
    } finally {
      cleanupRepo(repoDir);
    }
  });

  it('returns invalid-json for an empty file', () => {
    const repoDir = makeTempRepo();
    try {
      const p = join(repoDir, 'empty.json');
      writeFileSync(p, '', 'utf-8');
      const result = readCertification(p);
      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.equal(result.error.code, 'invalid-json');
      }
    } finally {
      cleanupRepo(repoDir);
    }
  });

  it('returns schema-mismatch for malformed-artifact.json', () => {
    const result = readCertification(join(FIXTURE_DIR, 'malformed-artifact.json'));
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.code, 'schema-mismatch');
      assert.ok(Array.isArray(result.error.detail?.errors));
      assert.ok((result.error.detail?.errors as unknown[]).length > 0);
    }
  });

  it('returns unreadable when path points to a directory', () => {
    const repoDir = makeTempRepo();
    try {
      // mkdtempSync returns a directory; pass it as the file path
      const result = readCertification(repoDir);
      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.equal(result.error.code, 'unreadable');
      }
    } finally {
      cleanupRepo(repoDir);
    }
  });

  it('returns ok for a valid artifact file', () => {
    const repoDir = makeTempRepo();
    try {
      const artifact = makeValidArtifact();
      const path = writeCertification(repoDir, artifact);
      const result = readCertification(path);
      assert.ok(result.ok);
    } finally {
      cleanupRepo(repoDir);
    }
  });
});

// ─── listCertifications ────────────────────────────────────────────────────

describe('listCertifications', () => {
  it('returns empty array for a fresh repo with no certifications directory', () => {
    const repoDir = makeTempRepo();
    try {
      withIsolatedGlobalCertificationRoot(() => {
        const paths = listCertifications(repoDir);
        assert.deepEqual(paths, []);
      });
    } finally {
      cleanupRepo(repoDir);
    }
  });

  it('returns all artifact paths after writing multiple artifacts', () => {
    const repoDir = makeTempRepo();
    try {
      withIsolatedGlobalCertificationRoot(() => {
        const a1 = makeValidArtifact({ provider: 'anthropic', model: 'claude-sonnet-4-6', suiteVersion: 'v1' });
        const a2 = makeValidArtifact({ provider: 'anthropic', model: 'claude-opus-4-8', suiteVersion: 'v1' });
        const a3 = makeValidArtifact({ provider: 'openai', model: 'gpt-4o', suiteVersion: 'v1' });

        const p1 = writeScopedCertification(a1, { scope: 'global' });
        const p2 = writeScopedCertification(a2, { scope: 'global' });
        const p3 = writeScopedCertification(a3, { scope: 'global' });

        const listed = listCertifications(repoDir);
        assert.equal(listed.length, 3);
        assert.ok(listed.includes(p1));
        assert.ok(listed.includes(p2));
        assert.ok(listed.includes(p3));
      });
    } finally {
      cleanupRepo(repoDir);
    }
  });

  it('returned paths are all under the base certifications directory', () => {
    const repoDir = makeTempRepo();
    try {
      writeCertification(repoDir, makeValidArtifact());
      const listed = listCertifications(repoDir);
      for (const p of listed) {
        assert.ok(p.includes('.wavemill/native-agent-certifications'));
      }
    } finally {
      cleanupRepo(repoDir);
    }
  });

  it('does not return non-.json files', () => {
    const repoDir = makeTempRepo();
    try {
      const artifact = makeValidArtifact();
      const path = writeCertification(repoDir, artifact);
      // Write a non-json file in the same model directory
      const dir = path.substring(0, path.lastIndexOf('/'));
      writeFileSync(join(dir, 'README.txt'), 'not json', 'utf-8');

      const listed = listCertifications(repoDir);
      assert.ok(listed.every(p => p.endsWith('.json')));
    } finally {
      cleanupRepo(repoDir);
    }
  });
});

describe('scoped certification storage', () => {
  it('builds stable root-relative shared paths', () => {
    const root = makeTempRepo();
    try {
      const path = buildScopedCertificationPath({ root }, 'openrouter', 'z-ai/glm-5.2', 'v2');
      assert.ok(path.endsWith('/z-ai/glm-5.2/v2.json'));
      assert.ok(!path.includes('.wavemill/native-agent-certifications/.wavemill'));
    } finally {
      cleanupRepo(root);
    }
  });

  it('writes once and reads from another repo through the same shared root', () => {
    const root = makeTempRepo();
    const repoA = makeTempRepo();
    const repoB = makeTempRepo();
    try {
      const artifact = makeValidArtifact({ provider: 'openai', model: 'gpt-4o', suiteVersion: 'v2' });
      const path = writeScopedCertification(artifact, { root });
      assert.equal(
        buildScopedCertificationPath({ root }, 'openai', 'gpt-4o', 'v2'),
        path,
      );
      assert.ok(!path.startsWith(repoA));
      assert.ok(!path.startsWith(repoB));
      const listed = listScopedCertifications({ root });
      assert.deepEqual(listed, [path]);
      const read = readCertification(path);
      assert.ok(read.ok);
    } finally {
      cleanupRepo(root);
      cleanupRepo(repoA);
      cleanupRepo(repoB);
    }
  });
});

// ─── Live coding canary write guards (HOK-2943) ────────────────────────────

describe('validateCertificationForWrite liveCanary guards', () => {
  function makeCanary(overrides: Record<string, unknown> = {}) {
    return {
      scenarioId: 'live.coding.mutation-canary.v1',
      status: 'pass',
      isLive: true,
      phase: 'coding',
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      providerNativeId: 'claude-sonnet-4-6',
      identityFingerprint: 'test-fingerprint',
      catalogHash: 'registry',
      suiteVersion: 'v1',
      ranAt: '2026-06-01T00:00:00.000Z',
      limits: { maxWallClockMs: 240_000, maxTurns: 6, maxToolCalls: 10, maxTotalTokens: 60_000 },
      ...overrides,
    } as NativeCertificationArtifact['liveCanary'];
  }

  it('accepts a canary whose identity matches the artifact and subject', () => {
    const artifact = makeValidArtifact({ phase: 'patch', liveCanary: makeCanary() });
    assert.doesNotThrow(() => validateCertificationForWrite(artifact));
  });

  it('rejects canaries whose storage or subject identity diverges from the artifact', () => {
    for (const overrides of [
      { provider: 'other' },
      { model: 'other-model' },
      { suiteVersion: 'v9' },
      { providerNativeId: 'other-native' },
      { identityFingerprint: 'other-fingerprint' },
      { catalogHash: 'other-catalog' },
    ]) {
      const artifact = makeValidArtifact({ phase: 'patch', liveCanary: makeCanary(overrides) });
      assert.throws(
        () => validateCertificationForWrite(artifact),
        /liveCanary/,
        `expected rejection for ${JSON.stringify(overrides)}`,
      );
    }
  });

  it('rejects secret-shaped or local-path content in canary detail and evidence paths', () => {
    const secretDetail = makeValidArtifact({
      phase: 'patch',
      liveCanary: makeCanary({ detail: 'authorization header leaked: Bearer abc' }),
    });
    assert.throws(() => validateCertificationForWrite(secretDetail), /must not contain secrets/);

    const absolutePath = makeValidArtifact({
      phase: 'patch',
      liveCanary: makeCanary({
        evidence: {
          structuredMutationToolCalls: 1,
          mutationToolNames: ['apply_patch'],
          expectedSentinelHash: 'a'.repeat(64),
          changedPaths: ['/etc/passwd'],
          completionArtifactPresent: true,
        },
      }),
    });
    assert.throws(() => validateCertificationForWrite(absolutePath), /repo-relative/);

    const traversal = makeValidArtifact({
      phase: 'patch',
      liveCanary: makeCanary({
        evidence: {
          structuredMutationToolCalls: 1,
          mutationToolNames: ['apply_patch'],
          expectedSentinelHash: 'a'.repeat(64),
          changedPaths: ['src/../../outside.txt'],
          completionArtifactPresent: true,
        },
      }),
    });
    assert.throws(() => validateCertificationForWrite(traversal), /repo-relative/);
  });

  it('rejects implausible canary timestamps', () => {
    const badRanAt = makeValidArtifact({ phase: 'patch', liveCanary: makeCanary({ ranAt: 'not-a-date' }) });
    assert.throws(() => validateCertificationForWrite(badRanAt), /ranAt/);

    const inverted = makeValidArtifact({
      phase: 'patch',
      liveCanary: makeCanary({ expiresAt: '2026-05-01T00:00:00.000Z' }),
    });
    assert.throws(() => validateCertificationForWrite(inverted), /expiresAt/);
  });

  it('round-trips a canary-bearing artifact through write and read', () => {
    const previousRoot = process.env[GLOBAL_CERTIFICATION_ROOT_ENV];
    const root = mkdtempSync(join(tmpdir(), 'canary-store-'));
    process.env[GLOBAL_CERTIFICATION_ROOT_ENV] = root;
    try {
      const artifact = makeValidArtifact({ phase: 'patch', liveCanary: makeCanary() });
      const path = writeScopedCertification(artifact, { scope: 'global' });
      const read = readCertification(path);
      assert.equal(read.ok, true, JSON.stringify(read));
      const loaded = (read as { artifact: NativeCertificationArtifact }).artifact;
      assert.equal(loaded.liveCanary?.status, 'pass');
      assert.equal(loaded.liveCanary?.isLive, true);
    } finally {
      if (previousRoot === undefined) {
        delete process.env[GLOBAL_CERTIFICATION_ROOT_ENV];
      } else {
        process.env[GLOBAL_CERTIFICATION_ROOT_ENV] = previousRoot;
      }
      rmSync(root, { recursive: true, force: true });
    }
  });
});
