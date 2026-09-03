// Custom node:test reporter that aggregates per-file wall time into a bounded
// JSON artifact for CI shard balancing (HOK-2939).
//
// Wired as a SECOND reporter in tests/run-unit-tests.sh:
//   node --test \
//     --test-reporter=spec --test-reporter-destination=stdout \
//     --test-reporter=./tests/lib/file-timing-reporter.mjs \
//     --test-reporter-destination="$TIMINGS_FILE"
// so human-readable output is unchanged and the timing JSON goes to its own
// destination file.
//
// Output shape (consumed by tools/ci-test-timings.ts):
//   { suite, shard, generatedAt, results: [{ file, ms, result }] }
// Paths are repo-relative and values are numbers/short strings only -- the
// artifact must never contain secrets or environment contents.
//
// Robustness contract: a reporter bug must not change test outcomes. Every
// event is processed inside try/catch; on internal failure the reporter emits
// a diagnostic to stderr and still yields valid (possibly partial) JSON.

import path from 'node:path';
import process from 'node:process';

export default async function* fileTimingReporter(source) {
  // file -> { ms, failed }
  const files = new Map();
  const cwd = process.cwd();

  for await (const event of source) {
    try {
      const data = event.data ?? {};
      const file = typeof data.file === 'string' ? data.file : undefined;
      if (!file) continue;
      const rel = path.isAbsolute(file) ? path.relative(cwd, file) : file;
      const entry = files.get(rel) ?? { ms: 0, topLevelMs: 0, failed: false, sawSummary: false };

      switch (event.type) {
        case 'test:summary': {
          // Per-file summary carries the file's own wall time (all tests plus
          // hooks). Preferred over summing individual tests.
          const ms = data.duration_ms;
          if (Number.isFinite(ms)) {
            entry.ms = ms;
            entry.sawSummary = true;
          }
          break;
        }
        case 'test:pass':
        case 'test:fail': {
          if (event.type === 'test:fail') entry.failed = true;
          // Fallback aggregation in case a file never emits test:summary
          // (e.g. the file crashed before its plan completed): sum top-level
          // test durations.
          const ms = data.details?.duration_ms;
          if (data.nesting === 0 && Number.isFinite(ms)) {
            entry.topLevelMs += ms;
          }
          break;
        }
        default:
          break;
      }
      files.set(rel, entry);
    } catch (err) {
      process.stderr.write(`file-timing-reporter: ignoring event error: ${err?.message ?? err}\n`);
    }
  }

  let json = '{"results":[]}';
  try {
    // Case-level events attribute `file` to the module where the test
    // callback is DEFINED, so a delegated suite (a .test.ts file calling a
    // helper in another module) produces phantom entries for the helper
    // module. Only spawned test files emit test:summary, so when any summary
    // was seen, keep summary-backed entries exclusively; the all-entries
    // fallback covers runs where no summary appeared at all (e.g. every file
    // crashed before its plan completed). A file dropped here simply gets the
    // manifest's conservative default weight.
    const anySummary = [...files.values()].some((entry) => entry.sawSummary);
    const results = [...files.entries()]
      .filter(([, entry]) => !anySummary || entry.sawSummary)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([file, entry]) => ({
        file,
        ms: Math.max(1, Math.round(entry.sawSummary ? entry.ms : entry.topLevelMs)),
        result: entry.failed ? 'fail' : 'pass',
      }));
    json = JSON.stringify(
      {
        suite: process.env.WAVEMILL_TEST_SUITE ?? 'unit',
        shard: process.env.WAVEMILL_TEST_SHARD ?? '1',
        generatedAt: new Date().toISOString(),
        results,
      },
      null,
      2,
    );
  } catch (err) {
    process.stderr.write(`file-timing-reporter: failed to serialize timings: ${err?.message ?? err}\n`);
  }
  yield `${json}\n`;
}
