import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

function stripMatchingQuotes(value: string): string {
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return value.slice(1, -1);
    }
  }
  return value;
}

export function readDotEnvFile(dir?: string): Record<string, string> {
  if (!dir) {
    return {};
  }

  const envPath = resolve(dir, '.env');
  if (!existsSync(envPath)) {
    return {};
  }

  const env: Record<string, string> = {};
  for (const rawLine of readFileSync(envPath, 'utf-8').split(/\r?\n/)) {
    let line = rawLine.trim();
    if (!line || line.startsWith('#')) {
      continue;
    }
    if (line.startsWith('export ')) {
      line = line.slice('export '.length).trimStart();
    }

    const index = line.indexOf('=');
    if (index <= 0) {
      continue;
    }

    const key = line.slice(0, index).trim();
    const value = stripMatchingQuotes(line.slice(index + 1).trim());
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      env[key] = value;
    }
  }

  return env;
}

export function resolveEnvValue(
  names: Array<string | undefined>,
  repoDir?: string,
): string | undefined {
  const envFile = readDotEnvFile(repoDir);
  for (const name of names) {
    if (!name) {
      continue;
    }
    const processValue = process.env[name]?.trim();
    if (processValue) {
      return processValue;
    }
    const fileValue = envFile[name]?.trim();
    if (fileValue) {
      return fileValue;
    }
  }
  return undefined;
}
