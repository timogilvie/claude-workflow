import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { registerResource, toResourceRef, type ResourceRef } from '../resource-registry.ts';

function collectMarkdownFiles(root: string, output: string[]): void {
  if (!existsSync(root)) {
    return;
  }
  for (const entry of readdirSync(root)) {
    const path = join(root, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) {
      collectMarkdownFiles(path, output);
      continue;
    }
    if (stat.isFile() && entry.endsWith('.md')) {
      output.push(path);
    }
  }
}

export function describeMemoryAsset(root: string, path: string): { name: string; metadata: Record<string, unknown> } {
  const relativePath = relative(root, path);
  const normalizedPath = relativePath.replace(/[\\/]/g, '/');
  const metadata: Record<string, unknown> = {
    path,
    resourceClass: 'memory',
  };

  if (normalizedPath === '.wavemill/project-context.md') {
    metadata.memoryRole = 'project-context';
  } else if (normalizedPath.startsWith('.wavemill/context/concepts/')) {
    metadata.memoryRole = 'concept-page';
    metadata.conceptId = normalizedPath
      .replace('.wavemill/context/concepts/', '')
      .replace(/\.md$/, '');
  } else if (normalizedPath.startsWith('.wavemill/context/')) {
    metadata.memoryRole = 'subsystem-spec';
    metadata.subsystemId = normalizedPath
      .replace('.wavemill/context/', '')
      .replace(/\.md$/, '');
  }

  return {
    name: relativePath.replace(/\.md$/, '').replace(/[\\/]/g, '__'),
    metadata,
  };
}

export function registerMemoryAsset(
  path: string,
  content: string,
  repoDir?: string,
  metadata: Record<string, unknown> = {},
): ResourceRef | null {
  const root = resolve(repoDir || process.cwd());
  const described = describeMemoryAsset(root, path);
  return toResourceRef(registerResource({
    type: 'memory',
    name: described.name,
    content,
    uri: path,
    metadata: {
      ...described.metadata,
      ...metadata,
    },
  }, { repoDir: root }));
}

export function registerMemoryAssets(repoDir?: string): ResourceRef[] {
  const root = resolve(repoDir || process.cwd());
  const files: string[] = [];
  const projectContext = join(root, '.wavemill', 'project-context.md');
  if (existsSync(projectContext)) {
    files.push(projectContext);
  }
  collectMarkdownFiles(join(root, '.wavemill', 'context'), files);

  return files
    .map((path) => {
      const content = readFileSync(path, 'utf-8');
      return registerMemoryAsset(path, content, root);
    })
    .filter((entry): entry is ResourceRef => Boolean(entry));
}
