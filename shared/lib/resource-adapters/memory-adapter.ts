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

/**
 * Derive the memory tier for a given file path under the repo root.
 * - `hot`     → .wavemill/project-context.md
 * - `concept` → .wavemill/context/concepts/...
 * - `cold`    → .wavemill/context/...
 */
function deriveMemoryTier(filePath: string, root: string): 'hot' | 'cold' | 'concept' {
  const rel = relative(root, filePath).replace(/\\/g, '/');
  if (rel === '.wavemill/project-context.md') return 'hot';
  if (rel.startsWith('.wavemill/context/concepts/')) return 'concept';
  return 'cold';
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
      const tier = deriveMemoryTier(path, root);
      return toResourceRef(registerResource({
        type: 'memory',
        name: relative(root, path).replace(/\.md$/, '').replace(/[\\/]/g, '__'),
        content,
        uri: path,
        metadata: {
          path,
          tier,
        },
      }, { repoDir: root }));
    })
    .filter((entry): entry is ResourceRef => Boolean(entry));
}
