import type { EvalRecord } from './eval-schema.ts';

export interface VerificationMetricsWindow {
  startTime: Date;
  endTime: Date;
  repoId?: string;
  contractVersion?: string;
}

export interface VerificationMetrics {
  window: VerificationMetricsWindow;
  first_green_ci_rate: number | null;
  local_vs_remote_detection_rate: number | null;
  ci_remediation_rate: number | null;
  median_time_to_green_ms: number | null;
  failures_prevented_before_pr: number | null;
  operator_override_rate: number | null;
  total_records_analyzed: number;
}

function percent(numerator: number, denominator: number): number | null {
  if (denominator === 0) {
    return null;
  }
  return Number(((numerator / denominator) * 100).toFixed(6));
}

function validTimestamp(value: string | undefined): number | null {
  if (!value) {
    return null;
  }
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function isInWindow(record: EvalRecord, window: VerificationMetricsWindow): boolean {
  const timestamp = validTimestamp(record.timestamp);
  if (timestamp === null) {
    return false;
  }
  return timestamp >= window.startTime.getTime() && timestamp <= window.endTime.getTime();
}

function matchesSegments(record: EvalRecord, window: VerificationMetricsWindow): boolean {
  if (window.repoId && record.repoContext?.repoId !== window.repoId) {
    return false;
  }
  if (
    window.contractVersion
    && record.verificationTelemetry?.contract?.version !== window.contractVersion
  ) {
    return false;
  }
  return true;
}

function median(values: number[]): number | null {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const midpoint = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) {
    return sorted[midpoint];
  }
  return (sorted[midpoint - 1] + sorted[midpoint]) / 2;
}

function computeFirstGreenRate(records: EvalRecord[]): number | null {
  const remoteRuns = records.filter((record) =>
    record.verificationTelemetry?.remote_ci_verdict?.ran === true
    && (record.verificationTelemetry.remote_ci_verdict.check_count ?? 0) >= 1,
  );
  const firstGreen = remoteRuns.filter((record) =>
    record.verificationTelemetry?.remote_ci_verdict?.passed === true,
  );
  return percent(firstGreen.length, remoteRuns.length);
}

function computeDetectionRate(records: EvalRecord[]): number | null {
  const remoteFailures = records.filter((record) =>
    record.verificationTelemetry?.remote_ci_verdict?.passed === false
    && record.verificationTelemetry.remote_ci_verdict.remote_only_failure !== undefined,
  );
  const locallyDetected = remoteFailures.filter((record) =>
    record.verificationTelemetry?.remote_ci_verdict?.remote_only_failure === false,
  );
  return percent(locallyDetected.length, remoteFailures.length);
}

function computeRemediationRate(records: EvalRecord[]): number | null {
  const remoteFailures = records.filter((record) =>
    record.verificationTelemetry?.remote_ci_verdict?.passed === false
    && record.verificationTelemetry.remediation?.remote_fix_outcome !== undefined,
  );
  const remediated = remoteFailures.filter((record) =>
    record.verificationTelemetry?.remediation?.remote_fix_outcome === 'fixed',
  );
  return percent(remediated.length, remoteFailures.length);
}

function computeMedianTimeToGreen(records: EvalRecord[]): number | null {
  const durations = records.flatMap((record) => {
    const timeline = record.verificationTelemetry?.timeline;
    const start = typeof timeline?.local_start === 'number' ? timeline.local_start : validTimestamp(timeline?.local_start as unknown as string);
    const green = typeof timeline?.remote_ci_first_green === 'number' ? timeline.remote_ci_first_green : validTimestamp(timeline?.remote_ci_first_green as unknown as string);
    if (start === null || green === null || green < start) {
      return [];
    }
    return [green - start];
  });
  return median(durations);
}

function computeFailurePrevention(records: EvalRecord[]): number | null {
  const attempts = records.filter((record) =>
    record.verificationTelemetry?.local_verification?.ran === true,
  );
  const prevented = attempts.filter((record) =>
    record.verificationTelemetry?.local_verification?.passed === false
    && record.outcomes?.delivery?.prCreated === false,
  );
  return percent(prevented.length, attempts.length);
}

function computeOverrideRate(records: EvalRecord[]): number | null {
  const attempts = records.filter((record) => record.verificationTelemetry);
  const overrides = attempts.filter((record) =>
    record.verificationTelemetry?.operator_override?.applied === true,
  );
  return percent(overrides.length, attempts.length);
}

export function computeVerificationMetrics(
  records: EvalRecord[],
  window: VerificationMetricsWindow,
): VerificationMetrics {
  const filtered = records.filter((record) =>
    isInWindow(record, window) && matchesSegments(record, window),
  );

  return {
    window,
    first_green_ci_rate: computeFirstGreenRate(filtered),
    local_vs_remote_detection_rate: computeDetectionRate(filtered),
    ci_remediation_rate: computeRemediationRate(filtered),
    median_time_to_green_ms: computeMedianTimeToGreen(filtered),
    failures_prevented_before_pr: computeFailurePrevention(filtered),
    operator_override_rate: computeOverrideRate(filtered),
    total_records_analyzed: filtered.length,
  };
}
