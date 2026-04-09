import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';

export function resolveRepoDir(repoPath?: string): string {
  return resolve(repoPath || process.cwd());
}

export function getWavemillDir(repoDir: string): string {
  return join(repoDir, '.wavemill');
}

export function getContextDir(repoDir: string): string {
  return join(getWavemillDir(repoDir), 'context');
}

export function getConceptsDir(repoDir: string): string {
  return join(getContextDir(repoDir), 'concepts');
}

export function requireContextDir(repoDir: string): string {
  const contextDir = getContextDir(repoDir);
  if (!existsSync(contextDir)) {
    throw new Error('No subsystem specs found. Initialize first: wavemill context init');
  }
  return contextDir;
}

export function listConceptPaths(repoDir: string): string[] {
  const conceptsDir = getConceptsDir(repoDir);
  if (!existsSync(conceptsDir)) {
    return [];
  }

  return readdirSync(conceptsDir)
    .filter((file) => file.endsWith('.md'))
    .map((file) => join(conceptsDir, file));
}

export function listContextSpecPaths(repoDir: string): string[] {
  const contextDir = requireContextDir(repoDir);

  // Get subsystem specs (flat structure)
  const subsystemPaths = readdirSync(contextDir)
    .filter((file) => file.endsWith('.md'))
    .map((file) => join(contextDir, file));

  // Get concept pages (subdirectory)
  const conceptPaths = listConceptPaths(repoDir);

  return [...subsystemPaths, ...conceptPaths];
}

export function readContextSpec(repoDir: string, subsystemId: string): { contextDir: string; specPath: string; content: string } {
  const contextDir = getContextDir(repoDir);
  const specPath = join(contextDir, `${subsystemId}.md`);
  if (!existsSync(specPath)) {
    const available = existsSync(contextDir)
      ? readdirSync(contextDir)
          .filter((file) => file.endsWith('.md'))
          .map((file) => file.replace('.md', ''))
      : [];
    const list = available.length > 0
      ? `Available subsystems: ${available.join(', ')}`
      : 'No subsystems found';
    throw new Error(`Subsystem spec not found: ${specPath}. ${list}`);
  }

  return {
    contextDir,
    specPath,
    content: readFileSync(specPath, 'utf-8'),
  };
}

export function extractSubsystemName(content: string): string {
  const match = content.match(/^# Subsystem:\s*(.+)$/m);
  return match ? match[1].trim() : 'Unknown';
}

export function extractSection(content: string, sectionName: string): string {
  const lines = content.split('\n');
  const sectionRegex = new RegExp(`^##\\s+${sectionName}`, 'i');
  let inSection = false;
  const sectionLines: string[] = [];

  for (const line of lines) {
    if (sectionRegex.test(line)) {
      inSection = true;
      continue;
    }
    if (inSection && /^##\s+/.test(line)) {
      break;
    }
    if (inSection) {
      sectionLines.push(line);
    }
  }

  return sectionLines.join('\n');
}

export function extractKeyFiles(specContent: string): string[] {
  const files: string[] = [];
  const lines = specContent.split('\n');
  let inKeyFilesSection = false;

  for (const line of lines) {
    if (line.startsWith('## Key Files')) {
      inKeyFilesSection = true;
      continue;
    }
    if (inKeyFilesSection && line.startsWith('##')) {
      break;
    }
    if (inKeyFilesSection && line.startsWith('| `')) {
      const match = line.match(/\| `([^`]+)` \|/);
      if (match) {
        files.push(match[1]);
      }
    }
  }

  return files;
}

export function getSpecType(specPath: string): 'subsystem' | 'concept' {
  return specPath.split(sep).includes('concepts') ? 'concept' : 'subsystem';
}
