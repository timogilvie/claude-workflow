// Custom node:test reporter that aggregates per-FILE elapsed time and writes a
// single bounded JSON timing document to its --test-reporter-destination.
//
// Attached as a second reporter by tests/run-unit-tests.sh when --timing-out is
// passed; the primary spec reporter still writes human output to stdout.
//
// Event contract (verified against Node 22):
// - Every test file passed to `node --test` emits a nesting-0 `test:enqueue`
//   and a nesting-0 `test:complete` whose `name` is the file path exactly as
//   given on the command line (repo-relative here, since the runner cds to the
//   repo root). The complete event's `details.duration_ms` is the whole-file
//   duration and `details.passed` is the whole-file result — authoritative
//   even when the file's tests are defined in an imported helper module.
// - Case-level events carry `file` = the module where the test callback is
//   DEFINED, which for delegated suites is the helper, not the registered
//   test file. Only file-level events are therefore trusted for entry
//   identity; anything else would invent phantom entries for helper modules.
// - Defensive fallback: if a file-level complete never arrives (crashed
//   runner child), the sum of nesting-0 case durations attributed to that
//   file is used, and any `test:fail` attributed to it marks failure.
//
// Output contains only test ids (repo-relative paths), durations, and results —
// never environment content — so it is structurally free of secrets.
//
// Metadata comes from the environment:
//   WAVEMILL_TIMING_SHARD  e.g. "2/7" (default "1/1")
//   GITHUB_RUN_ID / GITHUB_SHA (default "local")

import path from 'node:path';

export default async function* unitTimingReporter(source) {
  // Registered test files (file-level events seen), keyed by absolute path.
  const files = new Map(); // file -> { durationMs, passed, sawComplete }
  // Fallback data keyed by whatever file a case event was attributed to.
  const caseSums = new Map(); // file -> ms
  const caseFails = new Set(); // file

  // The file-level wrapper's name is the CLI-specified path; resolving it
  // against cwd matches the absolute `file` field regardless of whether the
  // path was given repo-relative or as a bare basename.
  const isFileLevel = (data) =>
    typeof data?.file === 'string' &&
    typeof data?.name === 'string' &&
    data.nesting === 0 &&
    path.resolve(data.name) === data.file;

  for await (const event of source) {
    const data = event.data ?? {};
    const file = typeof data.file === 'string' ? data.file : undefined;
    if (!file) continue;

    switch (event.type) {
      case 'test:enqueue':
        if (isFileLevel(data) && !files.has(file)) {
          files.set(file, { durationMs: null, passed: null, sawComplete: false });
        }
        break;
      case 'test:complete':
        if (isFileLevel(data)) {
          const entry = files.get(file) ?? { durationMs: null, passed: null, sawComplete: false };
          entry.durationMs = data.details?.duration_ms ?? entry.durationMs;
          entry.passed = data.details?.passed ?? entry.passed;
          entry.sawComplete = true;
          files.set(file, entry);
        }
        break;
      case 'test:pass':
        if (data.nesting === 0 && !isFileLevel(data)) {
          caseSums.set(file, (caseSums.get(file) ?? 0) + (data.details?.duration_ms ?? 0));
        }
        break;
      case 'test:fail':
        if (isFileLevel(data)) {
          const entry = files.get(file) ?? { durationMs: null, passed: null, sawComplete: false };
          entry.passed = false;
          files.set(file, entry);
        } else {
          caseFails.add(file);
          if (data.nesting === 0) {
            caseSums.set(file, (caseSums.get(file) ?? 0) + (data.details?.duration_ms ?? 0));
          }
        }
        break;
      default:
        break;
    }
  }

  const cwd = process.cwd();
  const tests = [...files.entries()]
    .map(([file, entry]) => {
      const durationMs = entry.durationMs ?? caseSums.get(file) ?? 0;
      const failed = entry.passed === false || (entry.passed === null && caseFails.has(file));
      return {
        id: path.relative(cwd, file).split(path.sep).join('/'),
        elapsedMs: Math.round(durationMs),
        result: failed ? 'fail' : 'pass',
      };
    })
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const doc = {
    suite: 'unit',
    shard: process.env.WAVEMILL_TIMING_SHARD || '1/1',
    runId: process.env.GITHUB_RUN_ID || 'local',
    sha: process.env.GITHUB_SHA || 'local',
    generatedAt: new Date().toISOString(),
    tests,
  };

  yield `${JSON.stringify(doc)}\n`;
}
