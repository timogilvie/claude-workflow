import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const PI_PACKAGES = ['@earendil-works/pi-ai', '@earendil-works/pi-agent-core'] as const;
const EXACT_VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

export interface PiVersionDriftResult {
  ok: boolean;
  errors: string[];
}

export function checkPiVersionDrift(
  packageJsonPath = 'package.json',
  packageLockPath = 'package-lock.json',
): PiVersionDriftResult {
  const errors: string[] = [];
  const packageJson = readJson(packageJsonPath, errors);
  const packageLock = readJson(packageLockPath, errors);
  if (!packageJson || !packageLock) {
    return { ok: false, errors };
  }

  const rootDependencies = {
    ...asRecord(packageJson.dependencies),
    ...asRecord(packageJson.devDependencies),
    ...asRecord(packageJson.optionalDependencies),
  };
  const lockPackages = asRecord(packageLock.packages);
  const lockRoot = asRecord(lockPackages['']);
  const lockRootDependencies = {
    ...asRecord(lockRoot.dependencies),
    ...asRecord(lockRoot.devDependencies),
    ...asRecord(lockRoot.optionalDependencies),
  };

  for (const packageName of PI_PACKAGES) {
    const spec = rootDependencies[packageName];
    if (typeof spec !== 'string') {
      errors.push(`${packageName} is missing from package.json root dependencies`);
      continue;
    }
    if (!EXACT_VERSION_RE.test(spec)) {
      errors.push(`${packageName} must use an exact pinned version in package.json, found "${spec}"`);
    }

    const lockRootSpec = lockRootDependencies[packageName];
    if (typeof lockRootSpec !== 'string') {
      errors.push(`${packageName} is missing from package-lock.json root dependencies`);
    } else if (lockRootSpec !== spec) {
      errors.push(`${packageName} package-lock root spec "${lockRootSpec}" does not match package.json "${spec}"`);
    }

    const lockEntry = asRecord(lockPackages[`node_modules/${packageName}`]);
    const lockVersion = lockEntry.version;
    if (typeof lockVersion !== 'string') {
      errors.push(`${packageName} is missing a resolved node_modules entry in package-lock.json`);
    } else if (lockVersion !== spec) {
      errors.push(`${packageName} resolved lock version "${lockVersion}" does not match package.json "${spec}"`);
    }
  }

  return { ok: errors.length === 0, errors };
}

function readJson(path: string, errors: string[]): Record<string, unknown> | undefined {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  } catch (err) {
    errors.push(`Failed to read ${path}: ${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? value as Record<string, unknown> : {};
}

function main(): void {
  const packageJsonPath = process.argv[2] ?? 'package.json';
  const packageLockPath = process.argv[3] ?? 'package-lock.json';
  const result = checkPiVersionDrift(packageJsonPath, packageLockPath);
  if (result.ok) {
    console.log('Pi package versions are exactly pinned and lockfile-resolved.');
    return;
  }

  for (const error of result.errors) {
    console.error(error);
  }
  process.exitCode = 2;
}

if (import.meta.url === pathToFileURL(resolve(process.argv[1] ?? '')).href) {
  main();
}
