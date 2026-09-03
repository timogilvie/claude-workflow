import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path, { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseShellArray } from '../shared/lib/shard-balance.ts';

const __filename = fileURLToPath(import.meta.url);
const defaultRepoRoot = join(dirname(__filename), '..');
const TEST_ROOTS = ['shared', 'tools', 'src'];

export interface TestRegistrationResult {
  ok: boolean;
  discovered: string[];
  registered: string[];
  unregistered: string[];
  stale: string[];
  duplicates: string[];
  /** Custom-harness registrations listed more than once across the runner's arrays. */
  customDuplicates: string[];
  /** Custom-harness registrations whose files do not exist. */
  customMissing: string[];
}

export function checkTestRegistration(repoDir = defaultRepoRoot): TestRegistrationResult {
  const discovered = TEST_ROOTS.flatMap((root) => discoverTests(join(repoDir, root), root)).sort();
  const registered = parseUnitTestRegistry(readFileSync(join(repoDir, 'tests', 'run-unit-tests.sh'), 'utf8'))
    .filter(isScopedTest)
    .sort();
  const registeredSet = new Set(registered);
  const discoveredSet = new Set(discovered);
  const duplicates = [...new Set(registered.filter((testFile, index) => registered.indexOf(testFile) !== index))];

  // Custom-harness membership stays curated (not discovery-complete), but the
  // registered entries must be unique and must exist so the weighted
  // partitioner can never drop or double-run a test.
  const customScript = readFileSync(join(repoDir, 'tests', 'run-custom-tests.sh'), 'utf8');
  const customRegistered = [
    ...parseShellArray(customScript, 'CUSTOM_TS_TESTS'),
    ...parseShellArray(customScript, 'CUSTOM_SH_TESTS'),
  ];
  const customDuplicates = [
    ...new Set(customRegistered.filter((testFile, index) => customRegistered.indexOf(testFile) !== index)),
  ];
  const customMissing = customRegistered.filter((testFile) => !existsSync(join(repoDir, testFile))).sort();

  return {
    ok: discovered.every((testFile) => registeredSet.has(testFile))
      && registered.every((testFile) => discoveredSet.has(testFile))
      && duplicates.length === 0
      && customDuplicates.length === 0
      && customMissing.length === 0,
    discovered,
    registered,
    unregistered: discovered.filter((testFile) => !registeredSet.has(testFile)),
    stale: registered.filter((testFile) => !discoveredSet.has(testFile)),
    duplicates,
    customDuplicates,
    customMissing,
  };
}

export function formatTestRegistration(result: TestRegistrationResult): string {
  if (result.ok) {
    return `test-registration: ok (${result.discovered.length} discovered, ${result.registered.length} registered)`;
  }

  const lines = ['test-registration: test registry drift found:'];
  appendSection(lines, 'Unregistered test files:', result.unregistered);
  appendSection(lines, 'Stale unit test registrations:', result.stale);
  appendSection(lines, 'Duplicate unit test registrations:', result.duplicates);
  appendSection(lines, 'Duplicate custom harness registrations:', result.customDuplicates);
  appendSection(lines, 'Missing custom harness test files:', result.customMissing);
  lines.push(
    '',
    'Update tests/run-unit-tests.sh so every *.test.ts under shared/, tools/, and src/ is registered exactly once,',
    'and tests/run-custom-tests.sh so every custom harness entry is unique and its file exists.'
  );
  return lines.join('\n');
}

function appendSection(lines: string[], heading: string, entries: string[]): void {
  if (entries.length === 0) return;
  lines.push('', heading, ...entries.map((entry) => `- ${entry}`));
}

function discoverTests(directory: string, relativeDirectory: string): string[] {
  try {
    return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
      const relativePath = path.posix.join(relativeDirectory, entry.name);
      if (entry.isDirectory()) {
        return discoverTests(join(directory, entry.name), relativePath);
      }
      return entry.isFile() && entry.name.endsWith('.test.ts') ? [relativePath] : [];
    });
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

function parseUnitTestRegistry(script: string): string[] {
  const block = script.match(/^TESTS=\(\n(?<entries>[\s\S]*?)^\)/m)?.groups?.entries ?? '';
  return [...block.matchAll(/^\s*([^\s#][^\s]*\.test\.ts)\s*(?:#.*)?$/gm)].map((match) => match[1]);
}

function isScopedTest(testFile: string): boolean {
  return TEST_ROOTS.some((root) => testFile.startsWith(`${root}/`));
}

if (process.argv[1] === __filename) {
  const result = checkTestRegistration(process.argv[2] ?? defaultRepoRoot);
  const message = formatTestRegistration(result);
  if (!result.ok) {
    console.error(message);
    process.exit(1);
  }
  console.log(message);
}
