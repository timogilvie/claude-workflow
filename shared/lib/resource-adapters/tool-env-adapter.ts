import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { canonicalJsonStringify, hashContent, registerResource, toResourceRef, type ResourceRef } from '../resource-registry.ts';
import { DEFAULT_MODEL_REGISTRY, getEffectiveRegistry } from '../model-registry.ts';

function commandVersion(command: string, args: string[] = ['--version']): string | null {
  try {
    return execFileSync(command, args, {
      encoding: 'utf-8',
      timeout: 2_000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

export function registerToolEnvSnapshot(repoDir?: string): { environment: ResourceRef | null; tools: ResourceRef[] } {
  const root = resolve(repoDir || process.cwd());
  const toolVersions = {
    node: commandVersion('node'),
    claude: commandVersion('claude'),
    codex: commandVersion('codex'),
  };
  const toolRefs = Object.entries(toolVersions)
    .map(([tool, version]) => {
      if (!version) {
        return null;
      }
      return toResourceRef(registerResource({
        type: 'tool',
        name: tool,
        content: version,
        version,
        metadata: { version },
      }, { repoDir: root }));
    })
    .filter((entry): entry is ResourceRef => Boolean(entry));

  const configPath = resolve(root, '.wavemill-config.json');
  const configContent = existsSync(configPath) ? readFileSync(configPath, 'utf-8') : '{}';
  const registrySnapshot = canonicalJsonStringify(getEffectiveRegistry(root) || DEFAULT_MODEL_REGISTRY);
  const payload = canonicalJsonStringify({
    toolVersions,
    modelRegistryHash: hashContent(registrySnapshot),
    wavemillConfigHash: hashContent(configContent),
    platform: process.platform,
  });

  const environment = toResourceRef(registerResource({
    type: 'environment',
    name: 'runtime-environment',
    content: payload,
    metadata: {
      toolVersions,
      modelRegistryHash: hashContent(registrySnapshot),
      wavemillConfigHash: hashContent(configContent),
      platform: process.platform,
    },
    dependencies: toolRefs,
  }, { repoDir: root }));

  return { environment, tools: toolRefs };
}
