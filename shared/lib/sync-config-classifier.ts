export type LocalOverrideClassification =
  | 'will add to repo default'
  | 'already local-only'
  | 'requires decision';

export interface LocalOverrideClassificationEntry {
  path: string;
  label: LocalOverrideClassification;
  reason: string;
}

interface ClassifierOptions {
  baseConfig: Record<string, unknown>;
  localConfig: Record<string, unknown>;
  canonicalConfig: Record<string, unknown>;
}

const SECRET_KEY_PATTERN = /(api[_-]?key|token|password|secret|credential|auth|private[_-]?key)/i;
const UNIX_ABSOLUTE_PATTERN = /^\/(?:[^\0]*)$/;
const WINDOWS_ABSOLUTE_PATTERN = /^[A-Za-z]:\\/;
const HOME_OR_ENV_PATH_PATTERN = /^(~\/|\$[A-Za-z_][A-Za-z0-9_]*\/|%[A-Za-z_][A-Za-z0-9_]*%\\)/;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function walkLeafPaths(value: unknown, prefix = '', out: string[] = []): string[] {
  if (Array.isArray(value)) {
    if (prefix) {
      out.push(prefix);
    }
    return out;
  }

  if (!isPlainObject(value)) {
    if (prefix) {
      out.push(prefix);
    }
    return out;
  }

  const keys = Object.keys(value);
  if (keys.length === 0) {
    if (prefix) {
      out.push(prefix);
    }
    return out;
  }

  for (const key of keys) {
    const next = prefix ? `${prefix}.${key}` : key;
    walkLeafPaths(value[key], next, out);
  }

  return out;
}

function getValueAtPath(obj: Record<string, unknown>, path: string): unknown {
  if (!path) {
    return obj;
  }

  const parts = path.split('.');
  let current: unknown = obj;
  for (const part of parts) {
    if (!isPlainObject(current) || !Object.prototype.hasOwnProperty.call(current, part)) {
      return undefined;
    }
    current = current[part];
  }

  return current;
}

function hasPath(obj: Record<string, unknown>, path: string): boolean {
  if (!path) {
    return true;
  }

  const parts = path.split('.');
  let current: unknown = obj;
  for (const part of parts) {
    if (!isPlainObject(current) || !Object.prototype.hasOwnProperty.call(current, part)) {
      return false;
    }
    current = current[part];
  }

  return true;
}

function pathSegments(path: string): string[] {
  return path.split('.').filter(Boolean);
}

function looksSensitivePath(path: string): boolean {
  return pathSegments(path).some(segment => SECRET_KEY_PATTERN.test(segment));
}

function valueHasSensitiveContent(value: unknown): boolean {
  if (typeof value === 'string') {
    return UNIX_ABSOLUTE_PATTERN.test(value) || WINDOWS_ABSOLUTE_PATTERN.test(value) || HOME_OR_ENV_PATH_PATTERN.test(value);
  }

  if (Array.isArray(value)) {
    return value.some(item => valueHasSensitiveContent(item));
  }

  if (isPlainObject(value)) {
    return Object.entries(value).some(([key, child]) => SECRET_KEY_PATTERN.test(key) || valueHasSensitiveContent(child));
  }

  return false;
}

export function classifyLocalOverrideFields({ baseConfig, localConfig, canonicalConfig }: ClassifierOptions): LocalOverrideClassificationEntry[] {
  const entries: LocalOverrideClassificationEntry[] = [];
  const leafPaths = walkLeafPaths(localConfig);

  for (const path of leafPaths) {
    if (hasPath(baseConfig, path)) {
      continue;
    }

    const localValue = getValueAtPath(localConfig, path);
    if (looksSensitivePath(path) || valueHasSensitiveContent(localValue)) {
      entries.push({
        path,
        label: 'requires decision',
        reason:
          'Local override looks secret-like or host-specific. Decide explicitly before adding any shared default at this path.',
      });
      continue;
    }

    if (hasPath(canonicalConfig, path)) {
      entries.push({
        path,
        label: 'will add to repo default',
        reason:
          'Path is canonical and missing from .wavemill-config.json. sync-config may add the canonical default; local value remains local-only.',
      });
      continue;
    }

    entries.push({
      path,
      label: 'already local-only',
      reason: 'Path is not in canonical shared defaults and remains a local override.',
    });
  }

  return entries.sort((a, b) => a.path.localeCompare(b.path));
}
