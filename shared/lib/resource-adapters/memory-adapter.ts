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

export function registerMemoryAssets(repoDir?: string): ResourceRef[] {
  const root = resolve(repoDir || process.cwd());
  const files: string[] = [];
  const projectContext = join(root, 'project-context.md');
  if (existsSync(projectContext)) {
    files.push(projectContext);
  }
  collectMarkdownFiles(join(root, '.wavemill', 'context'), files);

  return files
    .map((path) => {
      const content = readFileSync(path, 'utf-8');
      return toResourceRef(registerResource({
        type: 'memory',
        name: relative(root, path).replace(/\.md$/, '').replace(/[\\/]/g, '__'),
        content,
        uri: path,
        metadata: {
          path,
        },
      }, { repoDir: root }));
    })
    .filter((entry): entry is ResourceRef => Boolean(entry));
}
