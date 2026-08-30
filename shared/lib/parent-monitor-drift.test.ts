import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  ParentMonitorDriftError,
  compareParentMonitorFiles,
  extractTopLevelFunctions,
  formatFunctionLocation,
} from './parent-monitor-drift.ts';

const fixture = String.raw;

describe('parent-monitor-drift', () => {
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
function after_monitor {
  echo after
}
`;

    const parentFunctions = extractTopLevelFunctions(script, 'parent');
    assert.deepEqual(parentFunctions.map(fn => `${fn.side}:${fn.name}:${fn.startLine}-${fn.endLine}`), [
      'parent:shared_fn:2-10',
      'parent:after_monitor:11-13',
    ]);

    const monitorFunctions = extractTopLevelFunctions(script, 'monitor');
    assert.deepEqual(monitorFunctions.map(fn => `${fn.side}:${fn.name}`), [
      'monitor:shared_fn',
      'monitor:after_monitor',
    ]);
  });

  it('formats side-aware function locations', () => {
    const [parentFn] = extractTopLevelFunctions('located() {\n  echo hi\n}\n', 'parent');
    const [monitorFn] = extractTopLevelFunctions('located() {\n  echo hi\n}\n', 'monitor');
    assert.equal(formatFunctionLocation(parentFn!), 'shared/lib/wavemill-mill.sh:1-3');
    assert.equal(formatFunctionLocation(monitorFn!), 'shared/lib/wavemill-monitor.sh:1-3');
  });

  it('reports duplicated identical and divergent functions across two files', () => {
    const parentScript = fixture`
same() {
  echo same
}
changed() {
  echo parent
}
parent_only() {
  echo parent
}
`;
    const monitorScript = fixture`
same() {
  echo same
}
changed() {
  echo monitor
}
monitor_only() {
  echo monitor
}
`;

    const report = compareParentMonitorFiles(parentScript, monitorScript);
    assert.deepEqual(report.duplicated, ['changed', 'same']);
    assert.deepEqual(report.identical, ['same']);
    assert.deepEqual(report.divergent.map(entry => entry.name), ['changed']);
    assert.match(report.divergent[0]!.diff, /parent changed/);
    assert.match(report.divergent[0]!.diff, /monitor changed/);
  });

  it('reports no duplicates when the sides share no function names', () => {
    const report = compareParentMonitorFiles(
      'parent_only() {\n  echo parent\n}\n',
      'monitor_only() {\n  echo monitor\n}\n',
    );
    assert.deepEqual(report.duplicated, []);
    assert.deepEqual(report.identical, []);
    assert.deepEqual(report.divergent, []);
  });

  it('rejects unterminated functions and heredocs', () => {
    assert.throws(
      () => extractTopLevelFunctions('broken() {\n  echo parent\n', 'parent'),
      (error: unknown) => error instanceof ParentMonitorDriftError && /Unterminated function broken in parent/.test(error.message),
    );

    assert.throws(
      () => extractTopLevelFunctions("broken() {\n  cat <<'INNER'\n}\n", 'monitor'),
      (error: unknown) => error instanceof ParentMonitorDriftError && /Unterminated heredoc INNER in monitor/.test(error.message),
    );
  });
});
