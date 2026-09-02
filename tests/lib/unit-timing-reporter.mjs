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
//   repo root); the complete event's `details.duration_ms` is the whole-file
//   duration.
// - Plain-script files (no node:test cases) additionally emit a file-level
//   `test:pass`/`test:fail` of the same shape.
// - Any failing test (case-level or file-level) emits `test:fail` carrying
//   `file`, so a file is marked failed iff any `test:fail` references it.
// - Defensive fallback: if a file-level complete event never arrives (crashed
//   runner child), the sum of that file's nesting-0 case durations is used.
//
// Output contains only test ids (repo-relative paths), durations, and results —
// never environment content — so it is structurally free of secrets.
//
// Metadata comes from the environment:
//   WAVEMILL_TIMING_SHARD  e.g. "2/5" (default "1/1")
//   GITHUB_RUN_ID / GITHUB_SHA (default "local")

import path from 'node:path';

export default async function* unitTimingReporter(source) {
  // file path -> { fileDurationMs, caseSumMs, failed, seen }
  const files = new Map();

  const entryFor = (file) => {
    let entry = files.get(file);
    if (!entry) {
      entry = { fileDurationMs: null, caseSumMs: 0, failed: false, seen: true };
      files.set(file, entry);
    }
    return entry;
  };

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
        if (isFileLevel(data)) entryFor(file);
        break;
      case 'test:complete':
        if (isFileLevel(data)) {
          entryFor(file).fileDurationMs = data.details?.duration_ms ?? null;
        }
        break;
      case 'test:pass':
        if (data.nesting === 0 && !isFileLevel(data)) {
          entryFor(file).caseSumMs += data.details?.duration_ms ?? 0;
        }
        break;
      case 'test:fail':
        entryFor(file).failed = true;
        if (data.nesting === 0 && !isFileLevel(data)) {
          entryFor(file).caseSumMs += data.details?.duration_ms ?? 0;
        }
        break;
      default:
        break;
    }
  }

  const cwd = process.cwd();
  const tests = [...files.entries()]
    .map(([file, entry]) => ({
      id: path.relative(cwd, file).split(path.sep).join('/'),
      elapsedMs: Math.round(entry.fileDurationMs ?? entry.caseSumMs),
      result: entry.failed ? 'fail' : 'pass',
    }))
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
