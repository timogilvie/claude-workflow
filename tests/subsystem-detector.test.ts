/**
 * Unit tests for subsystem-detector.ts
 *
 * Verifies subsystem detection logic without requiring a full repo setup.
 */

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { detectSubsystems, buildFindFilesImportingArgs } from '../shared/lib/subsystem-detector.ts';
import {
  buildGetFileTouchCountArgs,
  buildGetRecentChangesArgs,
  generateSubsystemSpec,
  writeSubsystemSpecs,
} from '../shared/lib/subsystem-spec-generator.ts';
import { _setExecFileCommandForTest } from '../shared/lib/shell-utils.ts';
import type { Subsystem } from '../shared/lib/subsystem-detector.ts';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  // Restore the exec helper seam in case a test overrode it.
  _setExecFileCommandForTest(null);
});

function makeTempRepo(): string {
  const repoDir = mkdtempSync(path.join(os.tmpdir(), 'subsystem-detector-'));
  tempDirs.push(repoDir);
  return repoDir;
}

describe('subsystem-detector', () => {
  describe('detectSubsystems', () => {
    it('detects subsystems in wavemill repo', () => {
      const subsystems = detectSubsystems(REPO_ROOT, {
        minFiles: 3,
        useGitAnalysis: false, // Skip git for speed
        maxSubsystems: 20,
      });

      // Should detect at least some subsystems
      assert.ok(subsystems.length > 0, 'Should detect at least one subsystem');

      // Each subsystem should have required fields
      for (const subsystem of subsystems) {
        assert.ok(subsystem.id, 'Subsystem should have an ID');
        assert.ok(subsystem.name, 'Subsystem should have a name');
        assert.ok(subsystem.description, 'Subsystem should have a description');
        assert.ok(Array.isArray(subsystem.keyFiles), 'Subsystem should have keyFiles array');
        assert.ok(subsystem.keyFiles.length >= 3, `Subsystem ${subsystem.id} should have at least 3 key files`);
        assert.ok(typeof subsystem.confidence === 'number', 'Confidence should be a number');
        assert.ok(subsystem.confidence >= 0 && subsystem.confidence <= 1, 'Confidence should be 0-1');
      }
    });

    it('respects maxSubsystems limit', () => {
      const subsystems = detectSubsystems(REPO_ROOT, {
        minFiles: 1,
        useGitAnalysis: false,
        maxSubsystems: 3,
      });

      assert.ok(subsystems.length <= 3, 'Should respect maxSubsystems limit');
    });

    it('detects different subsystem types', () => {
      const subsystems = detectSubsystems(REPO_ROOT, {
        minFiles: 3,
        useGitAnalysis: false,
        maxSubsystems: 20,
      });

      // Should detect subsystems using different methods
      const methods = new Set(subsystems.map(s => s.detectionMethod));
      assert.ok(methods.size > 0, 'Should use at least one detection method');
    });
  });

  describe('buildFindFilesImportingArgs', () => {
    it('returns grep as the executable with separated argv entries', () => {
      const { file, args } = buildFindFilesImportingArgs('react', '/repo/shared/lib');
      assert.equal(file, 'grep');
      // The source path must be a single argv element, not shell-joined.
      assert.equal(args[args.length - 1], '/repo/shared/lib');
      // The pattern must be a single argv element containing the package text.
      const pattern = args[args.length - 2];
      assert.ok(pattern.includes('react'), `pattern should include package name: ${pattern}`);
      assert.ok(pattern.startsWith('from '), `pattern should start with 'from ': ${pattern}`);
    });

    it('passes a source path with spaces and parentheses as a single argv element', () => {
      const sourcePath = '/repo/app/(auth)/has space/lib';
      const { args } = buildFindFilesImportingArgs('react', sourcePath);
      // The last arg is the source path, preserved as a single element.
      assert.equal(args[args.length - 1], sourcePath);
      // No argv element should be a space-joined fragment of the path.
      assert.ok(!args.includes('space/lib'), 'path should not be split on spaces');
    });

    it('escapes regex metacharacters in the package name', () => {
      const { args } = buildFindFilesImportingArgs('react.test', '/repo/shared');
      const pattern = args[args.length - 2];
      // The dot must be escaped so grep treats it literally.
      assert.ok(pattern.includes('react\\.test'), `pattern should escape dot: ${pattern}`);
    });

    it('uses one --include flag per extension instead of a brace glob', () => {
      const { args } = buildFindFilesImportingArgs('react', '/repo/shared');
      assert.ok(args.includes('--include=*.ts'), 'should include *.ts');
      assert.ok(args.includes('--include=*.js'), 'should include *.js');
      assert.ok(args.includes('--include=*.tsx'), 'should include *.tsx');
      assert.ok(args.includes('--include=*.jsx'), 'should include *.jsx');
      // The brace-style glob must not appear as a single --include value.
      assert.ok(!args.some(a => a.startsWith('--include=*.{')), 'should not use brace glob');
    });
  });

  describe('findFilesImporting via detectSubsystems (integration)', () => {
    it('detects a package subsystem with files in shell-special paths', () => {
      const repoDir = makeTempRepo();
      writeFileSync(
        path.join(repoDir, 'package.json'),
        JSON.stringify({ dependencies: { react: 'latest' } }) + '\n'
      );
      // Place importing files under shell-special directory names so the grep
      // source path contains parentheses, spaces, brackets, and quotes.
      mkdirSync(path.join(repoDir, 'shared', 'lib'), { recursive: true });
      mkdirSync(path.join(repoDir, 'app', '(auth)', 'dashboard'), { recursive: true });
      mkdirSync(path.join(repoDir, 'app', 'has space'), { recursive: true });

      const importingFiles = [
        'shared/lib/a.ts',
        'shared/lib/b.ts',
        'shared/lib/c.ts',
        'app/(auth)/dashboard/page.tsx',
        'app/has space/page.tsx',
      ];
      for (const file of importingFiles) {
        writeFileSync(path.join(repoDir, file), `import React from 'react';\nexport const x = React;\n`);
      }

      const subsystems = detectSubsystems(repoDir, {
        minFiles: 3,
        useGitAnalysis: false,
        maxSubsystems: 20,
        sourceDirs: ['shared', 'app'],
      });

      // Package detection runs grep across the source dirs. Directory detection
      // only finds 1 file under `app/(auth)` (< minFiles), so the only way the
      // `(auth)` file reaches a subsystem's keyFiles is via the grep-based
      // package scan finding it through a shell-special path. The package and
      // directory subsystems may merge (>50% keyFile overlap); either way the
      // merged subsystem must carry the special-path file.
      const specialFileOwner = subsystems.find(s =>
        s.keyFiles.some(f => f.includes('(auth)'))
      );
      assert.ok(
        specialFileOwner,
        `some subsystem should include a file under (auth): ${subsystems.map(s => s.keyFiles.join(',')).join(' | ')}`
      );
      assert.ok(
        specialFileOwner!.keyFiles.length >= 3,
        `owning subsystem should have >=3 key files, got ${specialFileOwner!.keyFiles.length}`
      );
    });

    it('passes the source path to grep as a single argv element (no shell interpolation)', () => {
      const repoDir = makeTempRepo();
      writeFileSync(
        path.join(repoDir, 'package.json'),
        JSON.stringify({ dependencies: { react: 'latest' } }) + '\n'
      );
      mkdirSync(path.join(repoDir, 'shared', 'lib'), { recursive: true });
      writeFileSync(path.join(repoDir, 'shared', 'lib', 'a.ts'), `import React from 'react';\n`);
      writeFileSync(path.join(repoDir, 'shared', 'lib', 'b.ts'), `import React from 'react';\n`);
      writeFileSync(path.join(repoDir, 'shared', 'lib', 'c.ts'), `import React from 'react';\n`);

      const grepCalls: { file: string; args: readonly string[] }[] = [];
      _setExecFileCommandForTest((file, args, options) => {
        if (file === 'grep') {
          grepCalls.push({ file, args });
        }
        // Run the real command so detection behavior is preserved.
        return execFileSync(file, [...args], options);
      });

      detectSubsystems(repoDir, {
        minFiles: 3,
        useGitAnalysis: false,
        maxSubsystems: 20,
        sourceDirs: ['shared'],
      });

      assert.ok(grepCalls.length > 0, 'grep should be invoked for package detection');
      for (const call of grepCalls) {
        // The source path (last arg) must be a single argv element exactly
        // matching the joined path — no shell splitting or quoting.
        const sourcePathArg = call.args[call.args.length - 1];
        assert.ok(
          sourcePathArg.startsWith(repoDir),
          `source path arg should start with repoDir: ${sourcePathArg}`
        );
        // No argv element should be the literal command-string prefix that the
        // old shell-based implementation would have produced.
        assert.ok(!call.args.includes('2>/dev/null'), 'should not shell-redirect via argv');
        assert.ok(!call.args.some(a => a.includes('|| true')), 'should not shell-or via argv');
        // The grep executable is invoked directly, not through a shell.
        assert.equal(call.file, 'grep');
      }
    });
  });
});

/**
 * Subsystem spec generator regression tests.
 *
 * These would normally live in a dedicated `subsystem-spec-generator.test.ts`
 * file, but the native coding tooling here can only edit existing source files
 * (apply_patch requires the target file to already exist) and cannot create new
 * source test files. They are colocated with the detector tests as a focused
 * regression for shell-special path handling across the subsystem context path.
 */
describe('subsystem-spec-generator (argv Git history queries)', () => {
  function makeTempRepo(): string {
    const repoDir = mkdtempSync(path.join(os.tmpdir(), 'spec-gen-'));
    tempDirs.push(repoDir);
    return repoDir;
  }

  function gitInit(repoDir: string): void {
    execFileSync('git', ['init', repoDir], { stdio: 'pipe' });
    execFileSync('git', ['-C', repoDir, 'config', 'user.email', 'spec-gen@wavemill.test'], { stdio: 'pipe' });
    execFileSync('git', ['-C', repoDir, 'config', 'user.name', 'Spec Gen Test'], { stdio: 'pipe' });
  }

  function gitCommit(repoDir: string, message: string): void {
    execFileSync('git', ['-C', repoDir, 'add', '.'], { stdio: 'pipe' });
    execFileSync('git', ['-C', repoDir, 'commit', '-m', message], { stdio: 'pipe' });
  }

  describe('buildGetFileTouchCountArgs', () => {
    it('passes each key file as a separate argv element after --', () => {
      const keyFiles = [
        'app/(auth)/dashboard/page.tsx',
        'app/has space/page.tsx',
        '--leading-dash.ts',
      ];
      const { file, args } = buildGetFileTouchCountArgs(keyFiles, '2024-01-01');
      assert.equal(file, 'git');
      const dashIndex = args.indexOf('--');
      assert.ok(dashIndex >= 0, 'args should contain --');
      const afterDash = args.slice(dashIndex + 1);
      assert.deepEqual(afterDash, keyFiles);
      // Each path is its own argv element (no space-joining).
      assert.ok(args.includes('app/(auth)/dashboard/page.tsx'));
      assert.ok(args.includes('app/has space/page.tsx'));
      assert.ok(args.includes('--leading-dash.ts'));
      // The -- arg appears exactly once.
      assert.equal(args.filter(a => a === '--').length, 1);
      // since flag is passed as a single argv element.
      assert.ok(args.includes('--since=2024-01-01'));
    });

    it('caps key files at 20 entries', () => {
      const keyFiles = Array.from({ length: 25 }, (_, i) => `file${i}.ts`);
      const { args } = buildGetFileTouchCountArgs(keyFiles, '2024-01-01');
      const dashIndex = args.indexOf('--');
      const afterDash = args.slice(dashIndex + 1);
      assert.equal(afterDash.length, 20);
      assert.deepEqual(afterDash, keyFiles.slice(0, 20));
    });

    it('handles an empty key file array', () => {
      const { args } = buildGetFileTouchCountArgs([], '2024-01-01');
      const dashIndex = args.indexOf('--');
      assert.ok(dashIndex >= 0);
      assert.equal(args.slice(dashIndex + 1).length, 0);
    });
  });

  describe('buildGetRecentChangesArgs', () => {
    it('passes a negative limit and each file after --', () => {
      const keyFiles = ['app/[team]/page.tsx', 'app/glob*literal/page.tsx'];
      const { file, args } = buildGetRecentChangesArgs(keyFiles, 5);
      assert.equal(file, 'git');
      assert.ok(args.includes('-5'));
      const dashIndex = args.indexOf('--');
      assert.ok(dashIndex >= 0);
      assert.deepEqual(args.slice(dashIndex + 1), keyFiles);
    });

    it('clamps non-positive limits to 1', () => {
      const { args } = buildGetRecentChangesArgs(['a.ts'], 0);
      assert.ok(args.includes('-1'));
      assert.ok(!args.includes('-0'));
    });
  });

  describe('generateSubsystemSpec with shell-special key files', () => {
    it('counts file touches and surfaces recent changes without shell parse errors', () => {
      const repoDir = makeTempRepo();
      gitInit(repoDir);

      // Files with shell-special names.
      const specialFiles = [
        'app/(auth)/dashboard/page.tsx',
        'app/has space/page.tsx',
        'app/quote"dir/page.tsx',
        'app/[team]/page.tsx',
        'app/glob*literal/page.tsx',
        '--leading-dash.ts',
      ];
      for (const file of specialFiles) {
        const fullPath = path.join(repoDir, file);
        mkdirSync(path.dirname(fullPath), { recursive: true });
        writeFileSync(fullPath, `// ${file}\nexport const value = 1;\n`);
      }
      gitCommit(repoDir, 'feat: add shell-special key files');

      const subsystem: Subsystem = {
        id: 'special-paths',
        name: 'Special Paths',
        description: 'Subsystem with shell-special key file paths',
        keyFiles: specialFiles,
        testPatterns: [],
        dependencies: [],
        confidence: 0.8,
        detectionMethod: 'directory',
      };

      // Capture git invocations to assert argv literal handling.
      const gitCalls: { file: string; args: readonly string[] }[] = [];
      _setExecFileCommandForTest((file, args, options) => {
        if (file === 'git') {
          gitCalls.push({ file, args });
        }
        return execFileSync(file, [...args], options);
      });

      const spec = generateSubsystemSpec(subsystem, {
        repoDir,
        includeGitHistory: true,
      });

      // At least one git log call was made for the special paths.
      assert.ok(gitCalls.length > 0, 'git should be invoked for history queries');

      // Every git log call that includes a pathspec must place `--` before the
      // special file paths, and each path must be a single argv element.
      for (const call of gitCalls) {
        const dashIndex = call.args.indexOf('--');
        if (dashIndex < 0) continue;
        const afterDash = call.args.slice(dashIndex + 1);
        for (const special of specialFiles) {
          assert.ok(
            afterDash.includes(special),
            `git should receive ${special} as a separate argv element; got ${JSON.stringify(afterDash)}`
          );
        }
      }

      // The spec markdown should contain a non-zero file touch count.
      assert.match(spec, /Last updated/);
      const countMatch = spec.match(/Files touched:\*\* (\d+)/);
      assert.ok(countMatch, `spec should contain a numeric file touch count: ${spec.slice(0, 400)}`);
      const fileCount = Number(countMatch![1]);
      assert.ok(fileCount >= 1, `file touch count should be >= 1, got ${fileCount}`);
    });

    it('writes subsystem specs to the context dir for special-named key files', () => {
      const repoDir = makeTempRepo();
      gitInit(repoDir);

      const specialFiles = [
        'app/(auth)/dashboard/page.tsx',
        'app/has space/page.tsx',
        '--leading-dash.ts',
      ];
      for (const file of specialFiles) {
        const fullPath = path.join(repoDir, file);
        mkdirSync(path.dirname(fullPath), { recursive: true });
        writeFileSync(fullPath, `// ${file}\nexport const value = 1;\n`);
      }
      gitCommit(repoDir, 'init special files');

      const subsystem: Subsystem = {
        id: 'special-paths',
        name: 'Special Paths',
        description: 'Subsystem with shell-special key file paths',
        keyFiles: specialFiles,
        testPatterns: [],
        dependencies: [],
        confidence: 0.8,
        detectionMethod: 'directory',
      };

      const contextDir = path.join(repoDir, '.wavemill', 'context');
      writeSubsystemSpecs([subsystem], contextDir, { repoDir, includeGitHistory: true });

      const specPath = path.join(contextDir, 'special-paths.md');
      assert.ok(existsSync(specPath), 'subsystem spec file should be written');
      const spec = readFileSync(specPath, 'utf-8');
      assert.match(spec, /Special Paths/);
    });
  });
});

/**
 * First-run project context initialization integration test.
 *
 * Runs `tools/init-project-context.ts --force` against a fresh temp git repo
 * containing shell-special paths (`app/(auth)/...`) and verifies the context
 * files are written without shell parse errors reaching stderr.
 */
describe('first-run project context initialization (integration)', () => {
  it('writes project-context.md and subsystem specs without shell parse errors', () => {
    const repoDir = mkdtempSync(path.join(os.tmpdir(), 'init-project-context-'));
    tempDirs.push(repoDir);

    execFileSync('git', ['init', repoDir], { stdio: 'pipe' });
    execFileSync('git', ['-C', repoDir, 'config', 'user.email', 'init@wavemill.test'], { stdio: 'pipe' });
    execFileSync('git', ['-C', repoDir, 'config', 'user.name', 'Init Test'], { stdio: 'pipe' });

    writeFileSync(
      path.join(repoDir, 'package.json'),
      JSON.stringify({ dependencies: { react: 'latest', next: 'latest' } }) + '\n'
    );

    // Source files under shell-special paths that import a key package so the
    // package-based detector scans `app/(auth)/...` via grep.
    mkdirSync(path.join(repoDir, 'shared', 'lib'), { recursive: true });
    mkdirSync(path.join(repoDir, 'app', '(auth)', 'dashboard'), { recursive: true });
    const importingFiles = [
      'shared/lib/a.ts',
      'shared/lib/b.ts',
      'shared/lib/c.ts',
      'app/(auth)/dashboard/page.tsx',
    ];
    for (const file of importingFiles) {
      writeFileSync(path.join(repoDir, file), `import React from 'react';\nexport const x = React;\n`);
    }
    execFileSync('git', ['-C', repoDir, 'add', '.'], { stdio: 'pipe' });
    execFileSync('git', ['-C', repoDir, 'commit', '-m', 'init'], { stdio: 'pipe' });

    // Run the init tool as a subprocess so stderr is captured in isolation.
    const toolPath = path.resolve(REPO_ROOT, 'tools', 'init-project-context.ts');
    const result = spawnSync(process.execPath, ['--import', 'tsx', toolPath, '--force', repoDir], {
      encoding: 'utf-8',
      cwd: REPO_ROOT,
    });

    const stderr = result.stderr || '';
    assert.equal(
      result.status,
      0,
      `init tool exited ${result.status}; stderr: ${stderr.slice(-2000)}`
    );

    // stderr must not contain bash shell parse errors. The migrated subsystem
    // commands run with shell:false, so these cannot occur for special paths.
    assert.ok(!stderr.includes('/bin/bash: -c'), `stderr contains /bin/bash: -c: ${stderr}`);
    assert.ok(!stderr.includes('syntax error near unexpected token'), `stderr contains syntax error: ${stderr}`);
    assert.ok(!stderr.includes('unexpected EOF'), `stderr contains unexpected EOF: ${stderr}`);

    // project-context.md should be written.
    assert.ok(
      existsSync(path.join(repoDir, '.wavemill', 'project-context.md')),
      'project-context.md should exist'
    );

    // At least one subsystem spec should be written when detection finds enough files.
    const contextDir = path.join(repoDir, '.wavemill', 'context');
    assert.ok(existsSync(contextDir), 'context dir should exist');
    const specs = readdirSync(contextDir).filter(f => f.endsWith('.md'));
    assert.ok(specs.length > 0, `should write >=1 subsystem spec, got ${specs.length}`);
  });
});
