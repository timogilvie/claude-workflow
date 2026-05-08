import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { getProjectContextConfig } from './config.ts';

export interface CompactProjectContextOptions {
  repoDir: string;
  thresholdKb?: number;
  keepRecent?: number;
  dryRun?: boolean;
}

export interface CompactionResult {
  originalSizeBytes: number;
  newSizeBytes: number;
  archivedPath: string | null;
  entriesKept: number;
  entriesArchived: number;
  dryRun: boolean;
  skipped: boolean;
}

const RECENT_WORK_HEADER = '## Recent Work';

function parseRecentEntries(content: string): string[] {
  const normalized = content.replace(/^\s+/, '');
  if (!normalized) {
    return [];
  }

  const entryRegex = /(^###\s+\d{4}-\d{2}-\d{2}.*$[\s\S]*?)(?=^###\s+\d{4}-\d{2}-\d{2}.*$|\n---\s*\n|$)/gm;
  const headingMatches = Array.from(normalized.matchAll(entryRegex)).map((match) => match[1].trim());
  if (headingMatches.length > 0) {
    return headingMatches;
  }

  return normalized
    .split(/\n---\s*\n/g)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function monthStamp(date = new Date()): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  return `${year}${month}`;
}

async function writeFileAtomic(path: string, content: string): Promise<void> {
  const tempPath = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tempPath, content, 'utf-8');
  await rename(tempPath, path);
}

async function copyFileAtomic(src: string, dst: string): Promise<void> {
  const tempPath = `${dst}.tmp-${process.pid}-${Date.now()}`;
  const content = await readFile(src, 'utf-8');
  await writeFile(tempPath, content, 'utf-8');
  await rename(tempPath, dst);
}

async function resolveArchivePath(contextPath: string): Promise<string> {
  const folder = dirname(contextPath);
  const stamp = monthStamp();
  const rootName = `project-context-archive-${stamp}.md`;
  let candidate = join(folder, rootName);
  let index = 1;

  while (existsSync(candidate)) {
    candidate = join(folder, `project-context-archive-${stamp}-${index}.md`);
    index += 1;
  }

  return candidate;
}

export async function compactProjectContext(options: CompactProjectContextOptions): Promise<CompactionResult> {
  const repoDir = resolve(options.repoDir);
  const config = getProjectContextConfig(repoDir);
  const thresholdKb = options.thresholdKb ?? config.compactionThresholdKb;
  const keepRecent = options.keepRecent ?? config.recentWorkKeep;
  const dryRun = options.dryRun === true;

  const contextPath = join(repoDir, '.wavemill', 'project-context.md');
  if (!existsSync(contextPath)) {
    throw new Error(`project-context.md not found at ${contextPath}`);
  }

  const originalStat = await stat(contextPath);
  const originalSizeBytes = originalStat.size;
  const thresholdBytes = thresholdKb * 1024;

  if (originalSizeBytes <= thresholdBytes) {
    return {
      originalSizeBytes,
      newSizeBytes: originalSizeBytes,
      archivedPath: null,
      entriesKept: 0,
      entriesArchived: 0,
      dryRun,
      skipped: true,
    };
  }

  const originalContent = await readFile(contextPath, 'utf-8');
  const headerIndex = originalContent.indexOf(RECENT_WORK_HEADER);
  if (headerIndex < 0) {
    throw new Error("cannot compact: '## Recent Work' header not found — refusing to lose data");
  }

  const beforeHeader = originalContent.slice(0, headerIndex);
  const afterHeader = originalContent.slice(headerIndex + RECENT_WORK_HEADER.length);
  const entries = parseRecentEntries(afterHeader);
  const keptEntries = entries.slice(-keepRecent);
  const entriesArchived = Math.max(entries.length - keptEntries.length, 0);
  const entriesKept = keptEntries.length;

  const rebuiltContent = `${beforeHeader}${RECENT_WORK_HEADER}\n\n${keptEntries.join('\n\n---\n\n')}`;
  const newSizeBytes = Buffer.byteLength(rebuiltContent, 'utf-8');

  if (dryRun) {
    return {
      originalSizeBytes,
      newSizeBytes,
      archivedPath: null,
      entriesKept,
      entriesArchived,
      dryRun,
      skipped: false,
    };
  }

  const archivePath = await resolveArchivePath(contextPath);
  await mkdir(dirname(archivePath), { recursive: true });
  await copyFileAtomic(contextPath, archivePath);
  await writeFileAtomic(contextPath, rebuiltContent);

  return {
    originalSizeBytes,
    newSizeBytes,
    archivedPath: join('.wavemill', basename(archivePath)),
    entriesKept,
    entriesArchived,
    dryRun,
    skipped: false,
  };
}
