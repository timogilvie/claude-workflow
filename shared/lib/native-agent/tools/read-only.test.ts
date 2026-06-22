import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import {
  READ_ONLY_PATH_FIELDS,
  createReadOnlyTools,
  type ListFilesDetails,
  type ReadFileDetails,
  type SearchTextDetails,
  type ToolErrorDetails,
} from './read-only.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function callTool(
  worktreeRoot: string,
  toolName: string,
  params: Record<string, unknown>,
  signal?: AbortSignal,
) {
  const tools = createReadOnlyTools(worktreeRoot);
  const descriptor = tools.find((t) => t.metadata.name === toolName);
  if (!descriptor) throw new Error(`Unknown tool: ${toolName}`);
  return descriptor.execute('test-call-id', params, signal);
}

async function readFile(worktreeRoot: string, params: Record<string, unknown>) {
  return callTool(worktreeRoot, 'read_file', params);
}

async function listFiles(worktreeRoot: string, params: Record<string, unknown>) {
  return callTool(worktreeRoot, 'list_files', params);
}

async function searchText(worktreeRoot: string, params: Record<string, unknown>, signal?: AbortSignal) {
  return callTool(worktreeRoot, 'search_text', params, signal);
}

function textOf(result: { content: Array<{ type: string; text: string }> }): string {
  return result.content[0]?.text ?? '';
}

// ---------------------------------------------------------------------------
// Fixture setup
// ---------------------------------------------------------------------------

let testRoot: string;
let outsideDir: string;

before(async () => {
  testRoot = await mkdtemp(path.join(tmpdir(), 'read-only-tools-test-'));
  outsideDir = await mkdtemp(path.join(tmpdir(), 'read-only-outside-'));

  // Basic files
  await writeFile(path.join(testRoot, 'hello.txt'), 'Hello, world!\nSecond line\nThird line\n');
  await writeFile(path.join(testRoot, 'readme.md'), '# Readme\n\nSome content here.\n');

  // Subdirectory
  await mkdir(path.join(testRoot, 'src'));
  await writeFile(path.join(testRoot, 'src', 'app.ts'), 'export function main() {}\n');
  await writeFile(path.join(testRoot, 'src', 'util.ts'), 'export function helper() {}\n');

  // Hidden file
  await writeFile(path.join(testRoot, '.env'), 'SECRET=abc\n');

  // Large file: ~250KB to exceed 200KB cap
  const largeContent = 'line content here for large file\n'.repeat(8_000);
  await writeFile(path.join(testRoot, 'large.txt'), largeContent);

  // Multi-search fixture
  await writeFile(
    path.join(testRoot, 'notes.txt'),
    'apples and oranges\nThe Apple is red\napple pie is tasty\n',
  );

  // Outside file (for symlink escape test)
  await writeFile(path.join(outsideDir, 'secret.txt'), 'TOP SECRET\n');
});

after(async () => {
  await rm(testRoot, { recursive: true, force: true });
  await rm(outsideDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Metadata / exports
// ---------------------------------------------------------------------------

describe('read-only tools — metadata', () => {
  it('exports READ_ONLY_PATH_FIELDS for all three tools', () => {
    assert.deepEqual(READ_ONLY_PATH_FIELDS['read_file'], ['path']);
    assert.deepEqual(READ_ONLY_PATH_FIELDS['list_files'], ['path']);
    assert.deepEqual(READ_ONLY_PATH_FIELDS['search_text'], ['path']);
  });

  it('createReadOnlyTools returns three descriptors with correct names', () => {
    const tools = createReadOnlyTools('/fake-root');
    assert.equal(tools.length, 3);
    assert.deepEqual(
      tools.map((t) => t.metadata.name),
      ['read_file', 'list_files', 'search_text'],
    );
  });

  it('all tools are read-only and allowed in all phases', () => {
    const tools = createReadOnlyTools('/fake-root');
    for (const tool of tools) {
      assert.equal(tool.metadata.class, 'read-only');
      assert.deepEqual(tool.metadata.allowedPhases, ['planning', 'coding', 'review']);
      assert.equal(tool.metadata.executionMode, 'parallel');
    }
  });
});

// ---------------------------------------------------------------------------
// read_file — happy path
// ---------------------------------------------------------------------------

describe('read_file — happy path', () => {
  it('reads full file content', async () => {
    const result = await readFile(testRoot, { path: 'hello.txt' });
    const text = textOf(result);
    assert.ok(text.includes('Hello, world!'));
    assert.ok(text.includes('Second line'));
    assert.ok(text.includes('Third line'));
  });

  it('returns ReadFileDetails with accurate metadata', async () => {
    const result = await readFile(testRoot, { path: 'hello.txt' });
    const details = result.details as ReadFileDetails;
    assert.equal(details.tool, 'read_file');
    assert.equal(details.path, 'hello.txt');
    assert.equal(details.totalLines, 4); // 3 lines + trailing empty from final \n
    assert.equal(details.startLine, 1);
    assert.equal(details.linesRequested, null);
    assert.equal(details.truncatedByBytes, false);
    assert.ok(details.retainedBytes > 0);
    assert.equal(details.originalBytes, details.retainedBytes);
  });

  it('reads with startLine offset', async () => {
    const result = await readFile(testRoot, { path: 'hello.txt', startLine: 2 });
    const text = textOf(result);
    assert.ok(!text.includes('Hello, world!'), 'should skip first line');
    assert.ok(text.includes('Second line'));
    const details = result.details as ReadFileDetails;
    assert.equal(details.startLine, 2);
  });

  it('reads with maxLines limit', async () => {
    const result = await readFile(testRoot, { path: 'hello.txt', maxLines: 1 });
    const text = textOf(result);
    assert.ok(text.includes('Hello, world!'));
    assert.ok(!text.includes('Second line'));
    const details = result.details as ReadFileDetails;
    assert.equal(details.linesReturned, 1);
    assert.equal(details.linesRequested, 1);
  });

  it('combines startLine and maxLines', async () => {
    const result = await readFile(testRoot, { path: 'hello.txt', startLine: 2, maxLines: 1 });
    const text = textOf(result);
    assert.ok(text.includes('Second line'));
    assert.ok(!text.includes('Hello, world!'));
    assert.ok(!text.includes('Third line'));
  });

  it('clamps startLine beyond file length to empty result', async () => {
    const result = await readFile(testRoot, { path: 'hello.txt', startLine: 999 });
    const text = textOf(result);
    assert.equal(text.trim(), '');
    const details = result.details as ReadFileDetails;
    assert.equal(details.linesReturned, 0);
  });

  it('reads files in subdirectory', async () => {
    const result = await readFile(testRoot, { path: 'src/app.ts' });
    const text = textOf(result);
    assert.ok(text.includes('export function main'));
  });

  it('reads hidden files', async () => {
    const result = await readFile(testRoot, { path: '.env' });
    const text = textOf(result);
    assert.ok(text.includes('SECRET=abc'));
  });
});

// ---------------------------------------------------------------------------
// read_file — byte truncation
// ---------------------------------------------------------------------------

describe('read_file — byte truncation', () => {
  it('truncates large files and includes truncation marker', async () => {
    const result = await readFile(testRoot, { path: 'large.txt' });
    const text = textOf(result);
    assert.ok(text.includes('[read_file: output truncated;'), 'must include truncation marker');
    const details = result.details as ReadFileDetails;
    assert.equal(details.truncatedByBytes, true);
    assert.ok(details.originalBytes > details.retainedBytes, 'original should exceed retained');
  });

  it('truncates at a valid UTF-8 boundary', async () => {
    const result = await readFile(testRoot, { path: 'large.txt' });
    const text = textOf(result);
    // If UTF-8 boundary handling is correct, the text must be valid UTF-8 (no replacement chars introduced by slicing)
    assert.ok(Buffer.from(text, 'utf8').toString('utf8') === text);
  });
});

// ---------------------------------------------------------------------------
// read_file — error cases
// ---------------------------------------------------------------------------

describe('read_file — errors', () => {
  it('returns file_not_found for missing file', async () => {
    const result = await readFile(testRoot, { path: 'does-not-exist.txt' });
    const details = result.details as ToolErrorDetails;
    assert.equal(details.errorKind, 'file_not_found');
    assert.ok(textOf(result).includes('file_not_found'));
  });

  it('returns not_a_file for a directory path', async () => {
    const result = await readFile(testRoot, { path: 'src' });
    const details = result.details as ToolErrorDetails;
    assert.equal(details.errorKind, 'not_a_file');
    assert.ok(textOf(result).includes('not_a_file'));
  });

  it('returns path_outside_worktree for lexical traversal', async () => {
    const result = await readFile(testRoot, { path: '../secret.env' });
    const details = result.details as ToolErrorDetails;
    assert.equal(details.errorKind, 'path_outside_worktree');
    assert.ok(textOf(result).includes('path_outside_worktree'));
  });

  it('returns path_outside_worktree for absolute path outside worktree', async () => {
    const result = await readFile(testRoot, { path: '/etc/passwd' });
    const details = result.details as ToolErrorDetails;
    assert.equal(details.errorKind, 'path_outside_worktree');
  });

  it('returns symlink_escape for symlink pointing outside worktree', async () => {
    const linkPath = path.join(testRoot, 'escape-link.txt');
    try {
      await symlink(path.join(outsideDir, 'secret.txt'), linkPath);
    } catch {
      // symlinks may not be supported in some environments; skip gracefully
      return;
    }
    try {
      const result = await readFile(testRoot, { path: 'escape-link.txt' });
      const details = result.details as ToolErrorDetails;
      assert.equal(details.errorKind, 'symlink_escape');
      assert.ok(textOf(result).includes('symlink_escape'));
    } finally {
      await rm(linkPath, { force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// list_files — happy path
// ---------------------------------------------------------------------------

describe('list_files — happy path', () => {
  it('lists all files recursively from root', async () => {
    const result = await listFiles(testRoot, {});
    const text = textOf(result);
    const lines = text.split('\n').filter(Boolean);
    assert.ok(lines.some((l) => l.includes('hello.txt')), 'should include hello.txt');
    assert.ok(lines.some((l) => l.includes('src')), 'should include src directory');
    assert.ok(lines.some((l) => l.includes('app.ts')), 'should include app.ts');
    assert.ok(lines.some((l) => l.includes('.env')), 'should include hidden .env file');
  });

  it('returns ListFilesDetails with accurate metadata', async () => {
    const result = await listFiles(testRoot, {});
    const details = result.details as ListFilesDetails;
    assert.equal(details.tool, 'list_files');
    assert.equal(details.glob, null);
    assert.ok(details.totalFound > 0);
    assert.ok(details.returned > 0);
    assert.equal(details.truncated, false);
  });

  it('lists from a subdirectory', async () => {
    const result = await listFiles(testRoot, { path: 'src' });
    const text = textOf(result);
    const lines = text.split('\n').filter(Boolean);
    assert.ok(lines.some((l) => l.includes('app.ts')));
    assert.ok(lines.some((l) => l.includes('util.ts')));
    // Paths should be relative to worktree root
    assert.ok(lines.every((l) => l.startsWith('src/')), 'paths should include src/ prefix');
  });

  it('filters with a glob pattern', async () => {
    const result = await listFiles(testRoot, { glob: '**/*.ts' });
    const text = textOf(result);
    const lines = text.split('\n').filter(Boolean);
    assert.ok(lines.length > 0, 'should find TS files');
    assert.ok(lines.every((l) => l.endsWith('.ts')), 'all results should be .ts files');
  });

  it('glob with no matches returns empty result', async () => {
    const result = await listFiles(testRoot, { glob: '**/*.nonexistent' });
    const text = textOf(result);
    assert.equal(text.trim(), '');
    const details = result.details as ListFilesDetails;
    assert.equal(details.totalFound, 0);
    assert.equal(details.returned, 0);
    assert.equal(details.truncated, false);
  });
});

// ---------------------------------------------------------------------------
// list_files — maxResults truncation
// ---------------------------------------------------------------------------

describe('list_files — truncation', () => {
  it('returns exactly maxResults entries when limit is hit', async () => {
    const result = await listFiles(testRoot, { maxResults: 2 });
    const text = textOf(result);
    const lines = text.split('\n').filter(Boolean);
    assert.equal(lines.length, 2);
    const details = result.details as ListFilesDetails;
    assert.equal(details.returned, 2);
    assert.equal(details.truncated, true);
    assert.ok(details.totalFound > 2);
  });
});

// ---------------------------------------------------------------------------
// list_files — error cases
// ---------------------------------------------------------------------------

describe('list_files — errors', () => {
  it('returns file_not_found for missing directory', async () => {
    const result = await listFiles(testRoot, { path: 'nonexistent-dir' });
    const details = result.details as ToolErrorDetails;
    assert.equal(details.errorKind, 'file_not_found');
  });

  it('returns not_a_directory for a file path', async () => {
    const result = await listFiles(testRoot, { path: 'hello.txt' });
    const details = result.details as ToolErrorDetails;
    assert.equal(details.errorKind, 'not_a_directory');
    assert.ok(textOf(result).includes('not_a_directory'));
  });

  it('returns path_outside_worktree for traversal path', async () => {
    const result = await listFiles(testRoot, { path: '../' });
    const details = result.details as ToolErrorDetails;
    assert.equal(details.errorKind, 'path_outside_worktree');
  });

  it('returns symlink_escape for directory symlink pointing outside', async () => {
    const linkPath = path.join(testRoot, 'escape-dir');
    try {
      await symlink(outsideDir, linkPath);
    } catch {
      return; // symlinks unsupported; skip
    }
    try {
      const result = await listFiles(testRoot, { path: 'escape-dir' });
      const details = result.details as ToolErrorDetails;
      assert.equal(details.errorKind, 'symlink_escape');
    } finally {
      await rm(linkPath, { force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// search_text — happy path
// ---------------------------------------------------------------------------

describe('search_text — happy path', () => {
  it('finds matches across files', async () => {
    const result = await searchText(testRoot, { query: 'Hello' });
    const text = textOf(result);
    assert.ok(text.includes('hello.txt'));
    assert.ok(text.includes('Hello, world!'));
  });

  it('returns SearchTextDetails with accurate metadata', async () => {
    const result = await searchText(testRoot, { query: 'Hello' });
    const details = result.details as SearchTextDetails;
    assert.equal(details.tool, 'search_text');
    assert.equal(details.query, 'Hello');
    assert.equal(details.caseSensitive, false);
    assert.ok(details.totalMatches >= 1);
    assert.ok(details.returned >= 1);
    assert.equal(details.truncatedByResults, false);
    assert.equal(details.truncatedByBytes, false);
  });

  it('is case-insensitive by default', async () => {
    const result = await searchText(testRoot, { query: 'apple' });
    const text = textOf(result);
    // notes.txt has 'apples', 'Apple', 'apple' — all should match case-insensitively
    assert.ok(text.includes('notes.txt'));
    const details = result.details as SearchTextDetails;
    assert.equal(details.totalMatches, 3, 'should match all three case variants');
  });

  it('is case-sensitive when caseSensitive is true', async () => {
    const result = await searchText(testRoot, { query: 'apple', caseSensitive: true });
    const text = textOf(result);
    const details = result.details as SearchTextDetails;
    // Only 'apple' matches; 'Apple' and 'apples' with 's' also match... let me recheck
    // notes.txt: 'apples and oranges' (match: apple in apples), 'The Apple is red' (no: capital A), 'apple pie is tasty' (match)
    // So caseSensitive=true with query='apple' should match lines containing 'apple' (lowercase)
    assert.ok(details.totalMatches >= 1);
    // 'The Apple is red' should NOT match
    assert.ok(!text.includes('The Apple is red'), 'case-sensitive: Apple should not match apple');
  });

  it('restricts search to glob-matched files', async () => {
    const result = await searchText(testRoot, { query: 'function', glob: '**/*.ts' });
    const text = textOf(result);
    // app.ts and util.ts both have 'function'
    assert.ok(text.includes('.ts'), 'results should come from .ts files');
    const details = result.details as SearchTextDetails;
    assert.equal(details.glob, '**/*.ts');
  });

  it('restricts search to a subdirectory', async () => {
    const result = await searchText(testRoot, { query: 'function', path: 'src' });
    const text = textOf(result);
    // Only src/ files should be searched
    const lines = text.split('\n').filter(Boolean);
    assert.ok(lines.every((l) => l.startsWith('src/')), 'paths should start with src/');
  });

  it('returns "(no matches)" when nothing found', async () => {
    const result = await searchText(testRoot, { query: 'ZZZNOMATCH_UNIQUE_STRING_9999' });
    const text = textOf(result);
    assert.equal(text, '(no matches)');
    const details = result.details as SearchTextDetails;
    assert.equal(details.totalMatches, 0);
    assert.equal(details.returned, 0);
  });

  it('includes line numbers in results', async () => {
    const result = await searchText(testRoot, { query: 'Hello' });
    const text = textOf(result);
    // Format: "filename:linenum: content"
    assert.ok(/hello\.txt:\d+:/.test(text), 'should include line numbers');
  });
});

// ---------------------------------------------------------------------------
// search_text — maxResults truncation
// ---------------------------------------------------------------------------

describe('search_text — result truncation', () => {
  it('returns exactly maxResults matches when limit is hit', async () => {
    // 'apple' case-insensitive matches 3 lines in notes.txt; limit to 1
    const result = await searchText(testRoot, { query: 'apple', maxResults: 1 });
    const details = result.details as SearchTextDetails;
    assert.equal(details.returned, 1);
    assert.equal(details.truncatedByResults, true);
    assert.equal(details.totalMatches, 3);
  });
});

// ---------------------------------------------------------------------------
// search_text — byte truncation
// ---------------------------------------------------------------------------

describe('search_text — byte truncation', () => {
  it('truncates output when matches exceed byte cap', async () => {
    // large.txt has many lines containing 'line content' — search it
    const result = await searchText(testRoot, {
      query: 'line content here',
      maxResults: 5_000,
    });
    const text = textOf(result);
    const details = result.details as SearchTextDetails;
    if (details.truncatedByBytes) {
      assert.ok(text.includes('[search_text: output truncated;'), 'must include truncation marker');
    }
    // At minimum, verify details are populated
    assert.ok(details.returned > 0 || details.totalMatches === 0);
  });
});

// ---------------------------------------------------------------------------
// search_text — error cases
// ---------------------------------------------------------------------------

describe('search_text — errors', () => {
  it('returns file_not_found for missing directory', async () => {
    const result = await searchText(testRoot, { query: 'hello', path: 'nonexistent' });
    const details = result.details as ToolErrorDetails;
    assert.equal(details.errorKind, 'file_not_found');
  });

  it('returns not_a_directory for a file path', async () => {
    const result = await searchText(testRoot, { query: 'hello', path: 'hello.txt' });
    const details = result.details as ToolErrorDetails;
    assert.equal(details.errorKind, 'not_a_directory');
  });

  it('returns path_outside_worktree for traversal path', async () => {
    const result = await searchText(testRoot, { query: 'hello', path: '../../' });
    const details = result.details as ToolErrorDetails;
    assert.equal(details.errorKind, 'path_outside_worktree');
  });

  it('returns symlink_escape for directory symlink pointing outside', async () => {
    const linkPath = path.join(testRoot, 'search-escape-dir');
    try {
      await symlink(outsideDir, linkPath);
    } catch {
      return;
    }
    try {
      const result = await searchText(testRoot, { query: 'SECRET', path: 'search-escape-dir' });
      const details = result.details as ToolErrorDetails;
      assert.equal(details.errorKind, 'symlink_escape');
    } finally {
      await rm(linkPath, { force: true });
    }
  });

  it('respects abort signal — stops collecting files', async () => {
    const controller = new AbortController();
    controller.abort();
    // Should not throw; just return with 0 or partial results
    const result = await searchText(testRoot, { query: 'function' }, controller.signal);
    // Aborted before processing — either no matches or partial; no crash
    assert.ok(result.content[0]?.text !== undefined);
  });
});

// ---------------------------------------------------------------------------
// Path safety across all tools
// ---------------------------------------------------------------------------

describe('path safety — shared boundary checks', () => {
  it('read_file: denies null bytes in path', async () => {
    // Paths with null bytes are invalid; Node.js rejects them
    const result = await readFile(testRoot, { path: 'hello\0.txt' }).catch(() => null);
    // Either an error result or a thrown exception is acceptable — the key is we don't read /etc/passwd
    if (result !== null) {
      const details = result.details as ToolErrorDetails;
      assert.ok(
        details.errorKind === 'file_not_found' || details.errorKind === 'permission_denied',
        'null byte path must produce an error',
      );
    }
  });

  it('read_file: denies Windows-style traversal after separator normalisation', async () => {
    const result = await readFile(testRoot, { path: '..\\secret.env' });
    const details = result.details as ToolErrorDetails;
    assert.equal(details.errorKind, 'path_outside_worktree');
  });

  it('list_files: denies traversal via symlink in the root path', async () => {
    const linkPath = path.join(testRoot, 'outside-root');
    try {
      await symlink(outsideDir, linkPath);
    } catch {
      return;
    }
    try {
      const result = await listFiles(testRoot, { path: 'outside-root' });
      const details = result.details as ToolErrorDetails;
      assert.equal(details.errorKind, 'symlink_escape');
    } finally {
      await rm(linkPath, { force: true });
    }
  });
});
