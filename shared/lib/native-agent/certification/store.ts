import {
  mkdirSync,
  openSync,
  fsyncSync,
  closeSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import Ajv from 'ajv';
import { CERTIFICATION_BASE_PATH, type NativeCertificationArtifact } from './schema.ts';
import { buildCertificationPath } from './loader.ts';
import { resolveCertificationStorageIdentity } from './identity.ts';
import {
  buildCertificationPathFromRoot,
  resolveCertificationStorage,
  type CertificationStorageOptions,
} from './storage.ts';

const CERTIFICATION_JSON_SCHEMA = JSON.parse(
  readFileSync(new URL('./schema.json', import.meta.url), 'utf-8'),
);

const ajv = new Ajv({ allErrors: true, strict: false, validateFormats: false });
const validateSchema = ajv.compile(CERTIFICATION_JSON_SCHEMA);
const SECRET_OR_PATH_PATTERN = /\b(?:api[_-]?key|token|secret|password|bearer|authorization|\/users\/|\/home\/|[a-z]:\\|\.wavemill\/|worktrees\/|dropbox\/)\b/i;
const MIN_CERTIFIED_AT = Date.parse('2024-01-01T00:00:00.000Z');
const MAX_FUTURE_SKEW_MS = 5 * 60 * 1000;

export type StoreErrorCode = 'not-found' | 'unreadable' | 'invalid-json' | 'schema-mismatch';

export interface StoreError {
  code: StoreErrorCode;
  message: string;
  path: string;
  detail?: Record<string, unknown>;
}

export type ReadResult =
  | { ok: true; artifact: NativeCertificationArtifact }
  | { ok: false; error: StoreError };

/**
 * Read a certification artifact from an absolute file path.
 * Returns finer-grained error codes than loader.ts's loadCertification().
 */
export function readCertification(filePath: string): ReadResult {
  // Stat first to distinguish not-found from unreadable (e.g. directory)
  let isFile: boolean;
  try {
    const s = statSync(filePath);
    isFile = s.isFile();
  } catch (err: unknown) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === 'ENOENT') {
      return {
        ok: false,
        error: {
          code: 'not-found',
          message: `certification artifact not found: ${filePath}`,
          path: filePath,
        },
      };
    }
    return {
      ok: false,
      error: {
        code: 'unreadable',
        message: `could not stat certification artifact: ${filePath}: ${e.message}`,
        path: filePath,
        detail: { errno: e.errno, code: e.code },
      },
    };
  }

  if (!isFile) {
    return {
      ok: false,
      error: {
        code: 'unreadable',
        message: `path is not a regular file: ${filePath}`,
        path: filePath,
      },
    };
  }

  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf-8');
  } catch (err: unknown) {
    const e = err as NodeJS.ErrnoException;
    return {
      ok: false,
      error: {
        code: 'unreadable',
        message: `could not read certification artifact: ${filePath}: ${e.message}`,
        path: filePath,
        detail: { errno: e.errno, code: e.code },
      },
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err: unknown) {
    const e = err as SyntaxError;
    return {
      ok: false,
      error: {
        code: 'invalid-json',
        message: `certification artifact contains invalid JSON: ${filePath}: ${e.message}`,
        path: filePath,
        detail: { parseError: e.message },
      },
    };
  }

  const valid = validateSchema(parsed);
  if (!valid) {
    return {
      ok: false,
      error: {
        code: 'schema-mismatch',
        message: `certification artifact does not match schema: ${filePath}`,
        path: filePath,
        detail: { errors: validateSchema.errors },
      },
    };
  }

  return { ok: true, artifact: parsed as NativeCertificationArtifact };
}

/**
 * Deterministic JSON serializer: sorts keys at every depth, preserves array
 * order, uses 2-space indent, ends with a trailing newline.
 * Exported so callers can assert shape stability in tests.
 */
export function serializeCertification(record: NativeCertificationArtifact): string {
  return JSON.stringify(sortKeys(record), null, 2) + '\n';
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v !== null && typeof v === 'object') {
    const sorted: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>).sort()) {
      sorted[k] = sortKeys((v as Record<string, unknown>)[k]);
    }
    return sorted;
  }
  return v;
}

/**
 * Serialize the record deterministically and write atomically via
 * <finalPath>.tmp-<pid>-<rand> → rename → finalPath.
 * Creates the parent directory if missing. Returns the final path.
 *
 * Throws on invalid path segments, fs write/rename failures, or records
 * that fail schema validation (write-side guard against corrupt artifacts).
 */
export function writeCertification(repoDir: string, record: NativeCertificationArtifact): string {
  validateCertificationForWrite(record, 'writeCertification');

  // buildCertificationPath throws on bad segment chars (path traversal, etc.)
  const finalPath = buildCertificationPath(repoDir, record.provider, record.model, record.suiteVersion);

  mkdirSync(dirname(finalPath), { recursive: true });

  const serialized = serializeCertification(record);
  const tmpPath = `${finalPath}.tmp-${process.pid}-${randomBytes(8).toString('hex')}`;

  writeFileSync(tmpPath, serialized, 'utf-8');

  // Best-effort fsync: durability is the rename boundary, but sync reduces
  // data loss window on crash between write and rename.
  try {
    const fd = openSync(tmpPath, 'r');
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch {
    // Swallow — rename is the durability boundary
  }

  try {
    renameSync(tmpPath, finalPath);
  } catch (err) {
    try { unlinkSync(tmpPath); } catch { /* best-effort cleanup */ }
    throw err;
  }

  try {
    const dirFd = openSync(dirname(finalPath), 'r');
    try {
      fsyncSync(dirFd);
    } finally {
      closeSync(dirFd);
    }
  } catch {
    // Best-effort directory fsync for filesystems that permit it.
  }

  return finalPath;
}

function writeCertificationToPath(finalPath: string, record: NativeCertificationArtifact): string {
  mkdirSync(dirname(finalPath), { recursive: true });

  const serialized = serializeCertification(record);
  const tmpPath = `${finalPath}.tmp-${process.pid}-${randomBytes(8).toString('hex')}`;

  writeFileSync(tmpPath, serialized, 'utf-8');

  try {
    const fd = openSync(tmpPath, 'r');
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch {
    // Swallow — rename is the durability boundary
  }

  try {
    renameSync(tmpPath, finalPath);
  } catch (err) {
    try { unlinkSync(tmpPath); } catch { /* best-effort cleanup */ }
    throw err;
  }

  try {
    const dirFd = openSync(dirname(finalPath), 'r');
    try {
      fsyncSync(dirFd);
    } finally {
      closeSync(dirFd);
    }
  } catch {
    // Best-effort directory fsync for filesystems that permit it.
  }

  return finalPath;
}

export function writeScopedCertification(
  record: NativeCertificationArtifact,
  options: CertificationStorageOptions = {},
): string {
  validateCertificationForWrite(record, 'writeScopedCertification');

  const storage = resolveCertificationStorage(options);
  const finalPath = buildCertificationPathFromRoot(
    storage.root,
    record.provider,
    record.model,
    record.suiteVersion,
  );
  return writeCertificationToPath(finalPath, record);
}

export function writeGlobalCertification(
  record: NativeCertificationArtifact,
  options: Omit<CertificationStorageOptions, 'scope' | 'repoDir'> = {},
): string {
  return writeScopedCertification(record, { ...options, scope: 'global' });
}

/**
 * Validate write-side invariants before any filesystem mutation.
 *
 * Atomic write contract: callers provide an already canonical v2 artifact.
 * The store serializes stable JSON to a sibling temporary file, fsyncs it,
 * renames over the final path, then best-effort fsyncs the parent directory.
 * Artifacts containing secrets, local paths, non-canonical identity, or
 * implausible timestamps are rejected before the temporary file is created.
 */
export function validateCertificationForWrite(
  record: NativeCertificationArtifact,
  label = 'writeCertification',
): void {
  const valid = validateSchema(record);
  if (!valid) {
    const summary = (validateSchema.errors ?? [])
      .map(e => `${e.instancePath || '(root)'} ${e.message}`)
      .join('; ');
    throw new Error(`${label}: record fails schema validation: ${summary}`);
  }

  const storageIdentity = resolveCertificationStorageIdentity(record.provider, record.model);
  if (record.provider !== storageIdentity.provider || record.model !== storageIdentity.model) {
    throw new Error(
      `${label}: artifact identity must be canonical storage identity ${storageIdentity.provider}/${storageIdentity.model}`,
    );
  }

  const certifiedAtMs = Date.parse(record.certifiedAt);
  if (!Number.isFinite(certifiedAtMs)) {
    throw new Error(`${label}: certifiedAt must be a valid ISO timestamp`);
  }
  const now = Date.now();
  if (certifiedAtMs < MIN_CERTIFIED_AT || certifiedAtMs > now + MAX_FUTURE_SKEW_MS) {
    throw new Error(`${label}: certifiedAt is outside the accepted publication window`);
  }
  if (record.expiresAt) {
    const expiresAtMs = Date.parse(record.expiresAt);
    if (!Number.isFinite(expiresAtMs) || expiresAtMs <= certifiedAtMs) {
      throw new Error(`${label}: expiresAt must be after certifiedAt`);
    }
  }

  for (const limitation of record.knownLimitations ?? []) {
    if (SECRET_OR_PATH_PATTERN.test(limitation)) {
      throw new Error(`${label}: knownLimitations must not contain secrets or local paths`);
    }
  }
}

/**
 * Return absolute paths of all `.json` artifacts under
 * <repoDir>/.wavemill/native-agent-certifications/, recursing through
 * provider/model directories. Does not parse contents.
 * Returns [] if the base directory does not exist.
 */
export function listCertifications(repoDir: string): string[] {
  const baseDir = join(repoDir, CERTIFICATION_BASE_PATH);
  return listCertificationFilesUnderRoot(baseDir);
}

export function listScopedCertifications(options: CertificationStorageOptions = {}): string[] {
  return listCertificationFilesUnderRoot(resolveCertificationStorage(options).root);
}

export function listGlobalCertifications(options: Omit<CertificationStorageOptions, 'scope' | 'repoDir'> = {}): string[] {
  return listScopedCertifications({ ...options, scope: 'global' });
}

function listCertificationFilesUnderRoot(baseDir: string): string[] {
  let entries: ReturnType<typeof readdirSync>;
  try {
    entries = readdirSync(baseDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const paths: string[] = [];

  for (const entry of entries) {
    const entryPath = join(baseDir, entry.name);
    if (entry.isDirectory()) {
      paths.push(...listCertificationFilesUnderRoot(entryPath));
      continue;
    }
    if (!entry.isFile()) continue;
    if (!entry.name.endsWith('.json')) continue;
    paths.push(entryPath);
  }

  return paths;
}
