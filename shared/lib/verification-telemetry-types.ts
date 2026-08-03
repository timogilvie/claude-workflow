/**
 * Verification telemetry: complete lifecycle from local recipe execution
 * through first remote CI verdict.
 *
 * All fields are optional to maintain backward compatibility with existing
 * eval records. Records without telemetry validate unchanged.
 *
 * @since 1.37.0
 */
export interface VerificationTelemetry {
  /** Contract source: 'github-enforced' | 'local-config' | 'derived' */
  contractSource?: string;

  /** Contract version (SemVer format, e.g. '1.0.0') */
  contractVersion?: string;

  /** Git HEAD SHA that was verified */
  verifiedHeadSha?: string;

  /** Git base/merge-base SHA used for comparison */
  verifiedBaseSha?: string;

  /** Timestamp when verification started (ISO 8601) */
  startedAt?: string;

  /** Timestamp when verification completed (ISO 8601) */
  completedAt?: string;

  /** Per-command execution results */
  commands?: VerificationCommand[];

  /** Aggregate execution summary */
  summary?: VerificationSummary;

  /** First remote CI verdict (from HOK-2604) */
  firstCiVerdict?: FirstCiVerdict;

  /** Failed-check deduplication fingerprint */
  failedCheckFingerprint?: string;

  /** Category of failure for grouping (e.g. 'lint', 'type', 'test', 'build') */
  failureCategory?: string;

  /** Marker: failure only detected on remote CI, not locally */
  remoteOnlyFailure?: boolean;

  /** Remediation attempts and outcomes */
  remediation?: RemediationAttempt[];

  /** Operator override if verification was bypassed */
  operatorOverride?: OperatorOverride;
}

/** Result of executing a single verification command */
export interface VerificationCommand {
  /** 1-indexed command position in recipe */
  index: number;

  /** Command description or shell command itself (sanitized) */
  commandName: string;

  /** Outcome: 'pass' | 'fail' | 'timeout' | 'error' */
  status: 'pass' | 'fail' | 'timeout' | 'error';

  /** Exit code (if available) */
  exitCode?: number;

  /** Wall-clock duration in milliseconds */
  durationMs?: number;

  /** Failure reason (max 256 chars, no secrets) */
  failureReason?: string;
}

/** Summary statistics for verification execution */
export interface VerificationSummary {
  /** Total commands in recipe */
  totalCommands: number;

  /** Commands that passed */
  passedCommands: number;

  /** Commands that failed */
  failedCommands: number;

  /** Commands that timed out */
  timeoutCommands: number;

  /** Overall recipe status: 'pass' | 'fail' | 'timeout' | 'error' */
  overallStatus: 'pass' | 'fail' | 'timeout' | 'error';

  /** Total execution time in seconds */
  totalTimeSeconds?: number;

  /** Whether recipe was overridden by operator */
  wasOverridden?: boolean;
}

/** First CI verdict from remote GitHub Actions (HOK-2604) */
export interface FirstCiVerdict {
  /** Timestamp when CI run started (ISO 8601) */
  startedAt?: string;

  /** Timestamp of first failure or final success (ISO 8601) */
  concludedAt?: string;

  /** Overall status: 'pass' | 'fail' | 'timeout' | 'error' */
  status: 'pass' | 'fail' | 'timeout' | 'error';

  /** Wall-clock time from PR creation to conclusion (seconds) */
  timeToVerdictSeconds?: number;

  /** Workflow run ID (for audit trail) */
  workflowRunId?: string;

  /** Link to CI logs (if available) */
  ciLogsUrl?: string;
}

/** Remediation attempt record */
export interface RemediationAttempt {
  /** 1-indexed attempt number */
  attemptNumber: number;

  /** What was changed (e.g. 'added missing test', 'fixed lint') */
  description: string;

  /** Outcome: 'passed' | 'still_failing' | 'timed_out' */
  outcome: 'passed' | 'still_failing' | 'timed_out';

  /** Time from failure to remediation start (seconds) */
  delaySeconds?: number;

  /** Time taken to remediate (seconds) */
  durationSeconds?: number;
}

/** Operator override marker */
export interface OperatorOverride {
  /** Reason why verification was bypassed */
  reason: string;

  /** Operator identifier (email or user ID) */
  operator: string;

  /** Timestamp of override (ISO 8601) */
  timestamp: string;
}

/** Metrics summary for dashboard display and alerting */
export interface VerificationMetrics {
  /** Time range these metrics cover (ISO 8601 date range) */
  period: {
    startDate: string;
    endDate: string;
  };

  /** Segmentation key (e.g. 'wavemill:v1', 'wavemill:v2') */
  contractVersion: string;

  /** Repository name or identifier */
  repository: string;

  /** First green CI rate: % of PRs with passing first CI */
  firstGreenCiRate: number; // 0.0-1.0

  /** Local vs remote detection rate: % of failures caught locally vs remote */
  localVsRemoteDetectionRate: number; // 0.0-1.0

  /** CI remediation rate: % of locally-failing PRs that passed after remediation */
  remediationSuccessRate: number; // 0.0-1.0

  /** Median time from PR creation to first green CI (seconds) */
  medianTimeToGreenSeconds: number;

  /** Count of PRs blocked locally before PR creation */
  failuresPrevented: number;

  /** Sample size for these metrics */
  sampleSize: number;

  /** Timestamp when metrics were computed */
  computedAt: string;
}

/** Raw aggregation input for metrics computation */
export interface VerificationMetricsInput {
  records: Array<{ verificationTelemetry?: VerificationTelemetry }>;
  contractVersion: string;
  repository: string;
  period: {
    startDate: string;
    endDate: string;
  };
}
