#!/usr/bin/env -S npx tsx

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runTool } from '../shared/lib/tool-runner.ts';
import { errorMessage } from '../shared/lib/error-utils.ts';

const PI_PACKAGES = ['@earendil-works/pi-ai', '@earendil-works/pi-agent-core'] as const;
const EXACT_VERSION = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

export type PiPackageName = typeof PI_PACKAGES[number];

export interface PiPackageCheck {
  packageName: PiPackageName;
  dependencySpec?: string;
  lockVersion?: string;
  installedVersion?: string;
  ok: boolean;
  problems: string[];
}

export interface PiVersionCheckResult {
  ok: boolean;
  integrationPassed: boolean;
  status: 'ok' | 'drift' | 'drift_allowed';
  packages: PiPackageCheck[];
  message: string;
}

function readJsonFile(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf-8'));
}

function objectRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object`);
  }
  return value as Record<string, unknown>;
}

function stringField(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function packageLockVersion(lock: Record<string, unknown>, packageName: PiPackageName): string | undefined {
  const packages = objectRecord(lock.packages, 'package-lock packages');
  const entry = packages[`node_modules/${packageName}`];
  if (entry === undefined) return undefined;
  return stringField(objectRecord(entry, `package-lock entry for ${packageName}`).version);
}

function rootDependencySpec(packageJson: Record<string, unknown>, packageName: PiPackageName): string | undefined {
  const dependencies = objectRecord(packageJson.dependencies, 'package.json dependencies');
  return stringField(dependencies[packageName]);
}

function installedVersion(repoDir: string, packageName: PiPackageName): string | undefined {
  const path = resolve(repoDir, 'node_modules', packageName, 'package.json');
  if (!existsSync(path)) return undefined;
  return stringField(objectRecord(readJsonFile(path), `${packageName} package.json`).version);
}

export function checkPiVersions(
  repoDir: string = process.cwd(),
  options: { integrationPassed?: boolean } = {},
): PiVersionCheckResult {
  const integrationPassed = options.integrationPassed === true || process.env.PI_INTEGRATION_PASSED === '1';
  const packageJson = objectRecord(readJsonFile(resolve(repoDir, 'package.json')), 'package.json');
  const packageLock = objectRecord(readJsonFile(resolve(repoDir, 'package-lock.json')), 'package-lock.json');

  const packages = PI_PACKAGES.map((packageName): PiPackageCheck => {
    const dependencySpec = rootDependencySpec(packageJson, packageName);
    const lockVersion = packageLockVersion(packageLock, packageName);
    const installed = installedVersion(repoDir, packageName);
    const problems: string[] = [];

    if (dependencySpec === undefined) {
      problems.push('missing package.json dependency');
    } else if (!EXACT_VERSION.test(dependencySpec)) {
      problems.push(`dependency spec is not pinned exactly: ${dependencySpec}`);
    }

    if (lockVersion === undefined) {
      problems.push('missing package-lock package entry');
    }

    if (dependencySpec !== undefined && lockVersion !== undefined && EXACT_VERSION.test(dependencySpec) && dependencySpec !== lockVersion) {
      problems.push(`package.json spec ${dependencySpec} does not match lockfile ${lockVersion}`);
    }

    if (installed !== undefined && lockVersion !== undefined && installed !== lockVersion) {
      problems.push(`installed version ${installed} does not match lockfile ${lockVersion}`);
    }

    return {
      packageName,
      dependencySpec,
      lockVersion,
      installedVersion: installed,
      ok: problems.length === 0,
      problems,
    };
  });

  const hasDrift = packages.some((pkg) => !pkg.ok);
  const ok = !hasDrift || integrationPassed;
  return {
    ok,
    integrationPassed,
    status: hasDrift ? (integrationPassed ? 'drift_allowed' : 'drift') : 'ok',
    packages,
    message: hasDrift
      ? integrationPassed
        ? 'Pi package drift detected but integration pass was supplied.'
        : 'Pi package drift detected. Run the integration suite or restore pinned versions.'
      : 'Pi package versions are pinned and match the lockfile.',
  };
}

if (import.meta.main) {
  runTool({
    name: 'check-pi-version',
    description: 'Check pinned Pi package versions against package-lock',
    options: {
      json: { type: 'boolean', description: 'Output result as JSON' },
      'integration-passed': { type: 'boolean', description: 'Allow drift after successful integration suite' },
    },
    examples: [
      'npx tsx tools/check-pi-version.ts',
      'npx tsx tools/check-pi-version.ts --json',
      'npx tsx tools/check-pi-version.ts --integration-passed',
    ],
    run({ args }) {
      try {
        const result = checkPiVersions(process.cwd(), {
          integrationPassed: args['integration-passed'] === true,
        });
        if (args.json) {
          console.log(JSON.stringify(result, null, 2));
        } else {
          console.log(result.message);
          for (const pkg of result.packages) {
            if (pkg.ok) continue;
            console.log(`${pkg.packageName}: ${pkg.problems.join('; ')}`);
          }
        }
        process.exitCode = result.ok ? 0 : 1;
      } catch (err) {
        const message = errorMessage(err);
        if (args.json) {
          console.log(JSON.stringify({ ok: false, status: 'error', message }, null, 2));
        } else {
          console.error(`Error: ${message}`);
        }
        process.exitCode = 2;
      }
    },
  });
}
