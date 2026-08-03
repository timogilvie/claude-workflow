export type CiFailureCategory = 'deterministic_local' | 'transient_infra' | 'github_only' | 'unknown';

export interface CiFailureClassifierInput {
  checkName: string;
  conclusion: string;
  logExcerpt?: string;
  repositoryContext?: {
    localTestCommand?: string;
  };
}

export interface CiFailureClassification {
  category: CiFailureCategory;
  localCommand?: string;
  reason: string;
}

const JOB_COMMANDS: Array<{ pattern: RegExp; command: string; reason: string }> = [
  { pattern: /\b(alembic|migration[- ]?chain)\b/i, command: 'npm run test:unit -- shared/lib/ready-stage.test.ts', reason: 'migration-chain job is locally replayable' },
  { pattern: /\b(unit[- ]?tests?|tests?|node[- ]?test)\b/i, command: 'npm test', reason: 'test job is locally replayable' },
  { pattern: /\b(shell[- ]?tests?|check[- ]?shell)\b/i, command: 'npm run lint', reason: 'shell lint/test job is locally replayable' },
  { pattern: /\b(typecheck|type[- ]?check|tsc)\b/i, command: 'npm run typecheck', reason: 'typecheck job is locally replayable' },
  { pattern: /\b(lint|eslint)\b/i, command: 'npm run lint', reason: 'lint job is locally replayable' },
  { pattern: /\b(build|compile)\b/i, command: 'npm run build', reason: 'build job is locally replayable' },
];

const GITHUB_ONLY_SIGNATURES: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /\b(approval|manual approval|required reviewer)\b/i, reason: 'approval required' },
  { pattern: /\b(branch protection|required status|merge queue)\b/i, reason: 'GitHub branch protection gate' },
  { pattern: /\b(security|codeql|dependabot|secret scanning|vulnerability)\b/i, reason: 'security gate' },
];

const TRANSIENT_SIGNATURES: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /\brunner lost communication\b/i, reason: 'runner lost communication' },
  { pattern: /\bcancel(?:led|ed) by infrastructure\b/i, reason: 'cancelled by infrastructure' },
  { pattern: /\b(timed? out|timeout|deadline exceeded)\b/i, reason: 'provider timeout' },
  { pattern: /\bHTTP\s*5\d\d\b|\b5\d\d server error\b/i, reason: 'provider HTTP 5xx' },
  { pattern: /\b(rate limited|secondary rate limit|too many requests)\b/i, reason: 'provider rate limited' },
  { pattern: /\b(flaky|network error|ECONNRESET|ETIMEDOUT|ENOTFOUND)\b/i, reason: 'transient provider or network failure' },
];

const DETERMINISTIC_LOG_SIGNATURES: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /\b(failed tests?|test suite failed|assertion(?:error)?|expected .+ received)\b/i, reason: 'test failure signature' },
  { pattern: /\b(TS\d{4}|type error|eslint|lint failed)\b/i, reason: 'static analysis failure signature' },
  { pattern: /\b(build failed|compilation failed|syntaxerror)\b/i, reason: 'build failure signature' },
  { pattern: /\bFAIL(?:ED)?:\s+/i, reason: 'deterministic failure signature' },
];

function combinedText(input: CiFailureClassifierInput): string {
  return [
    input.checkName,
    input.conclusion,
    input.logExcerpt ?? '',
  ].join('\n');
}

function commandForJob(checkName: string): { command: string; reason: string } | null {
  for (const candidate of JOB_COMMANDS) {
    if (candidate.pattern.test(checkName)) {
      return { command: candidate.command, reason: candidate.reason };
    }
  }
  return null;
}

export function classifyCiFailure(input: CiFailureClassifierInput): CiFailureClassification {
  const text = combinedText(input);
  const explicitCommand = input.repositoryContext?.localTestCommand?.trim();

  // Security/approval gates are intentionally operator-owned even when their
  // logs include generic words like "failed".
  for (const signature of GITHUB_ONLY_SIGNATURES) {
    if (signature.pattern.test(text)) {
      return { category: 'github_only', reason: signature.reason };
    }
  }

  // Transient infrastructure takes precedence over local replay: re-run CI
  // first instead of burning an LLM attempt on provider noise.
  for (const signature of TRANSIENT_SIGNATURES) {
    if (signature.pattern.test(text)) {
      return { category: 'transient_infra', reason: signature.reason };
    }
  }

  const mapped = commandForJob(input.checkName);
  if (mapped) {
    return {
      category: 'deterministic_local',
      localCommand: explicitCommand || mapped.command,
      reason: mapped.reason,
    };
  }

  for (const signature of DETERMINISTIC_LOG_SIGNATURES) {
    if (signature.pattern.test(text)) {
      return {
        category: 'deterministic_local',
        localCommand: explicitCommand || undefined,
        reason: signature.reason,
      };
    }
  }

  return { category: 'unknown', reason: 'no deterministic CI failure signature matched' };
}

export function truncateCiLogExcerpt(logExcerpt: string | undefined, maxBytes: number): string | undefined {
  if (!logExcerpt) {
    return undefined;
  }
  const limit = Number.isInteger(maxBytes) && maxBytes > 0 ? maxBytes : 16_384;
  const buffer = Buffer.from(logExcerpt, 'utf-8');
  if (buffer.byteLength <= limit) {
    return logExcerpt;
  }

  const marker = '[truncated: showing last CI log bytes]\n';
  const markerBytes = Buffer.byteLength(marker, 'utf-8');
  const tailLimit = Math.max(0, limit - markerBytes);
  return marker + buffer.subarray(buffer.byteLength - tailLimit).toString('utf-8');
}
