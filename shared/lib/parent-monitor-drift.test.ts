import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  ParentMonitorDriftError,
  compareParentMonitor,
  extractTopLevelFunctions,
  splitMonitorRegion,
} from './parent-monitor-drift.ts';

const fixture = String.raw;

describe('parent-monitor-drift', () => {
  it('splits parent and monitor regions around the monitor heredoc', () => {
    const script = fixture`
parent_only() {
  echo parent
}
cat > "$tmp" <<'MONITOR_EOF'
monitor_only() {
  echo monitor
}
MONITOR_EOF
after_monitor() {
  echo after
}
`;

    const region = splitMonitorRegion(script);
    assert.deepEqual(region.parentRanges, [[0, 4], [9, 12]]);
    assert.deepEqual(region.monitorRange, [5, 8]);
  });

  it('extracts top-level functions with nested groups, quotes, and heredocs', () => {
    const script = fixture`
shared_fn() {
  case "$1" in
    one) echo "quoted } brace" ;;
    two) { echo nested; }
  esac
  cat <<'INNER'
}
INNER
}
cat <<'MONITOR_EOF'
shared_fn() {
  case "$1" in
    one) echo "quoted } brace" ;;
    two) { echo nested; }
  esac
  cat <<'INNER'
}
INNER
}
MONITOR_EOF
function after_monitor {
  echo after
}
`;

    const functions = extractTopLevelFunctions(script);
    assert.deepEqual(functions.map(fn => `${fn.side}:${fn.name}:${fn.startLine}-${fn.endLine}`), [
      'parent:shared_fn:2-10',
      'parent:after_monitor:22-24',
      'monitor:shared_fn:12-20',
    ]);
  });

  it('reports duplicated identical and divergent functions', () => {
    const script = fixture`
same() {
  echo same
}
changed() {
  echo parent
}
parent_only() {
  echo parent
}
cat <<'MONITOR_EOF'
same() {
  echo same
}
changed() {
  echo monitor
}
monitor_only() {
  echo monitor
}
MONITOR_EOF
`;

    const report = compareParentMonitor(script);
    assert.deepEqual(report.duplicated, ['changed', 'same']);
    assert.deepEqual(report.identical, ['same']);
    assert.deepEqual(report.divergent.map(entry => entry.name), ['changed']);
    assert.match(report.divergent[0]!.diff, /parent changed/);
    assert.match(report.divergent[0]!.diff, /monitor changed/);
  });

  it('rejects missing monitor heredocs and unterminated functions', () => {
    assert.throws(
      () => splitMonitorRegion('only_parent() {\n  echo parent\n}\n'),
      /No MONITOR_EOF heredoc found/,
    );

    assert.throws(
      () => extractTopLevelFunctions("broken() {\n  echo parent\ncat <<'MONITOR_EOF'\nMONITOR_EOF\n"),
      (error: unknown) => error instanceof ParentMonitorDriftError && /Unterminated function broken/.test(error.message),
    );
  });
});
