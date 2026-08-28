import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  detectGlobalConfigIntegrity,
  detectRepoConfigIntegrity,
  locateJsonSyntaxError,
} from './config-integrity.ts';

const hasAjv = (() => {
  try {
    createRequire(import.meta.url)('ajv');
    return true;
  } catch {
    return false;
  }
})();

function makeTempRepo(): string {
  return mkdtempSync(join(tmpdir(), 'config-integrity-'));
}

function writeSchema(repoDir: string, schema: unknown): void {
  writeFileSync(join(repoDir, 'wavemill-config.schema.json'), JSON.stringify(schema, null, 2));
}

function permissiveSchema(): unknown {
  return {
    type: 'object',
    additionalProperties: true,
    properties: {
      mill: {
        type: 'object',
        additionalProperties: true,
        properties: {
          maxParallel: { type: 'number' },
        },
      },
    },
  };
}

test('malformed schema produces parse-error with location and excerpt', () => {
  const repoDir = makeTempRepo();
  try {
    writeFileSync(join(repoDir, 'wavemill-config.schema.json'), '{\n  "type": "object"\n}\n,\n{}\n');

    const issues = detectRepoConfigIntegrity(repoDir);

    assert.equal(issues.length, 1);
    assert.equal(issues[0].kind, 'parse-error');
    assert.equal(issues[0].file, join(repoDir, 'wavemill-config.schema.json'));
    assert.equal(typeof issues[0].line, 'number');
    assert.equal(typeof issues[0].column, 'number');
    assert.match(issues[0].excerpt ?? '', /,/);
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
  }
});

test('schema that is valid JSON but invalid schema produces compile error', { skip: !hasAjv }, () => {
  const repoDir = makeTempRepo();
  try {
    writeFileSync(join(repoDir, 'wavemill-config.schema.json'), '{"type":5}\n');

    const issues = detectRepoConfigIntegrity(repoDir);

    assert.equal(issues.length, 1);
    assert.equal(issues[0].kind, 'schema-compile-error');
    assert.equal(issues[0].file, join(repoDir, 'wavemill-config.schema.json'));
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
  }
});

test('malformed repo config names .wavemill-config.json', () => {
  const repoDir = makeTempRepo();
  try {
    writeSchema(repoDir, permissiveSchema());
    writeFileSync(join(repoDir, '.wavemill-config.json'), '{ "mill": }\n');

    const issues = detectRepoConfigIntegrity(repoDir);

    assert.ok(issues.some((issue) =>
      issue.kind === 'parse-error' &&
      issue.file === join(repoDir, '.wavemill-config.json') &&
      issue.line !== undefined &&
      issue.column !== undefined
    ));
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
  }
});

test('malformed local config names .wavemill-config.local.json', () => {
  const repoDir = makeTempRepo();
  try {
    writeSchema(repoDir, permissiveSchema());
    writeFileSync(join(repoDir, '.wavemill-config.local.json'), '{ "mill": }\n');

    const issues = detectRepoConfigIntegrity(repoDir);

    assert.ok(issues.some((issue) =>
      issue.kind === 'parse-error' &&
      issue.file === join(repoDir, '.wavemill-config.local.json')
    ));
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
  }
});

test('config violating schema produces validation error', { skip: !hasAjv }, () => {
  const repoDir = makeTempRepo();
  try {
    writeSchema(repoDir, permissiveSchema());
    writeFileSync(join(repoDir, '.wavemill-config.json'), JSON.stringify({ mill: { maxParallel: 'many' } }));

    const issues = detectRepoConfigIntegrity(repoDir);

    assert.equal(issues.length, 1);
    assert.equal(issues[0].kind, 'validation-error');
    assert.match(issues[0].message, /maxParallel|number|must be number/);
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
  }
});

test('valid schema and configs produce no issue', () => {
  const repoDir = makeTempRepo();
  try {
    writeSchema(repoDir, permissiveSchema());
    writeFileSync(join(repoDir, '.wavemill-config.json'), JSON.stringify({ mill: { maxParallel: 2 } }));
    writeFileSync(join(repoDir, '.wavemill-config.local.json'), JSON.stringify({ mill: { pollSeconds: 30 } }));

    assert.deepEqual(detectRepoConfigIntegrity(repoDir), []);
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
  }
});

test('missing config files with valid schema produce no issue', () => {
  const repoDir = makeTempRepo();
  try {
    writeSchema(repoDir, permissiveSchema());

    assert.deepEqual(detectRepoConfigIntegrity(repoDir), []);
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
  }
});

test('global config parse check covers malformed valid and missing files', () => {
  const homeDir = mkdtempSync(join(tmpdir(), 'config-integrity-home-'));
  const userConfigDir = join(homeDir, '.wavemill');
  try {
    assert.deepEqual(detectGlobalConfigIntegrity({ homeDir }), []);

    mkdirSync(userConfigDir, { recursive: true });
    writeFileSync(join(userConfigDir, 'config.json'), '{ bad json }\n');
    const malformed = detectGlobalConfigIntegrity({ homeDir });
    assert.equal(malformed.length, 1);
    assert.equal(malformed[0].kind, 'parse-error');
    assert.equal(malformed[0].file, join(userConfigDir, 'config.json'));

    writeFileSync(join(userConfigDir, 'config.json'), '{"ok":true}\n');
    assert.deepEqual(detectGlobalConfigIntegrity({ homeDir }), []);
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
  }
});

test('locateJsonSyntaxError handles full location position-only and unknown messages', () => {
  const text = '{\n  "a": 1,\n}\n';

  assert.deepEqual(
    locateJsonSyntaxError(text, new SyntaxError('Unexpected token } in JSON at position 13 (line 3 column 1)')),
    { position: 13, line: 3, column: 1 },
  );
  assert.deepEqual(
    locateJsonSyntaxError(text, new SyntaxError('Unexpected token } in JSON at position 13')),
    { position: 13, line: 3, column: 2 },
  );
  assert.deepEqual(locateJsonSyntaxError(text, new SyntaxError('Unexpected token')), {});
});

test('validator cache invalidates when schema changes on disk', { skip: !hasAjv }, () => {
  const repoDir = makeTempRepo();
  try {
    writeSchema(repoDir, {
      type: 'object',
      properties: { value: { type: 'string' } },
      additionalProperties: false,
    });
    writeFileSync(join(repoDir, '.wavemill-config.json'), '{"value":"ok"}\n');
    assert.deepEqual(detectRepoConfigIntegrity(repoDir), []);

    writeSchema(repoDir, {
      type: 'object',
      properties: { value: { type: 'number' } },
      additionalProperties: false,
    });
    const future = new Date(Date.now() + 2000);
    utimesSync(join(repoDir, 'wavemill-config.schema.json'), future, future);

    const issues = detectRepoConfigIntegrity(repoDir);
    assert.equal(issues.length, 1);
    assert.equal(issues[0].kind, 'validation-error');
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
  }
});
