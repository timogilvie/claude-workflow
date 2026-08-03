// TypeScript types for pre-PR verification configuration and runtime artifacts.

/** Pre-PR verification configuration loaded from .wavemill-config.json */
export interface PrePrVerificationConfig {
  enabled: boolean;
  required: boolean;
  source: 'github-enforced' | 'explicit';
  requiredChecks?: string[];
  recipe: PrePrVerificationRecipe;
  logCaptureLines?: number;
  draftFallback?: boolean;
  staleTtlSeconds?: number;
  compatibility?: {
    mode: 'allow' | 'warn' | 'block';
    warnAfterDays?: number;
  };
}

/** Verification recipe: ordered commands to execute */
export interface PrePrVerificationRecipe {
  commands: string[];
  timeoutSeconds?: number;
  retryPolicy?: {
    enabled: boolean;
    maxAttempts?: number;
    backoffSeconds?: number;
  };
}

/** Result of a single command execution */
export interface CommandResult {
  index: number;
  command: string;
  status: 'pass' | 'fail' | 'timeout' | 'error';
  exitCode?: number;
  durationMs?: number;
  logPath?: string;
  failureReason?: string;
}

/** Verification execution result */
export interface PrePrVerificationResult {
  status: 'pass' | 'fail' | 'timeout' | 'error';
  commands: CommandResult[];
  startTime?: number;
  endTime?: number;
}

/** Operator override marker recorded in artifact */
export interface OperatorOverride {
  reason: string;
  timestamp: string; // ISO 8601
  operator: string; // email or user identifier
}

/** Verification artifact persisted after running recipe */
export interface PrePrVerificationArtifact {
  version: string; // e.g., '1.0'
  timestamp: string; // ISO 8601
  workingBranch: string;
  headSha: string;
  baseSha: string;
  overriddenBy?: OperatorOverride | null;
  commands: Array<{
    index: number;
    command: string;
    status: 'pass' | 'fail' | 'timeout' | 'error';
    exitCode?: number;
    durationMs?: number;
    logPath?: string;
    failureReason?: string;
  }>;
  overallStatus: 'pass' | 'fail' | 'timeout' | 'error';
}

/** Gate check result */
export interface GateCheckResult {
  passed: boolean;
  reason?: string;
  artifact?: PrePrVerificationArtifact;
  recommendation?: string;
}
