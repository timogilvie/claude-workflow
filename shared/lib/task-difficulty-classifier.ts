/**
 * Task difficulty classifier for routing decisions.
 *
 * Classifies incoming tasks as trivial/moderate/hard/critical before model
 * selection to prevent wasting premium quota on simple work.
 *
 * Unlike difficulty-analyzer.ts (which operates on PR diffs post-implementation),
 * this classifier operates on task metadata and packet content at routing time.
 *
 * @module task-difficulty-classifier
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { DifficultyBand } from './eval-schema.ts';
import { escapeShellArg, execShellCommand } from './shell-utils.ts';

// ────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────

export type RoutingDifficulty = 'trivial' | 'moderate' | 'hard' | 'critical';

export interface TaskDifficultyResult {
  difficulty: RoutingDifficulty;
  rationale: string;
  source: 'llm' | 'heuristic' | 'cached';
  classifiedAt: string; // ISO 8601
}

export interface DifficultyFloor {
  allowHaiku: boolean;
  preferSonnet: boolean;
  preferOpus: boolean;
  neverHaikuAlone: boolean;
}

export interface ClassifyTaskOptions {
  title?: string;
  description?: string;
  packetContent?: string;
  repoDir?: string;
  model?: string;
  skipLlm?: boolean;
  /** Avoid cache reads/writes for latency-sensitive pure scoring paths. */
  skipCache?: boolean;
  cacheTtlDays?: number;
}

// ────────────────────────────────────────────────────────────────
// Constants
// ────────────────────────────────────────────────────────────────

const DEFAULT_CLASSIFIER_MODEL = 'claude-haiku-4-5-20251001';
const DEFAULT_CACHE_TTL_DAYS = 7;
const CACHE_MAX_LINES = 500;
const CLASSIFY_TIMEOUT_MS = 30_000;

const CRITICAL_KEYWORDS = [
  /\bpayment(s)?\b/i,
  /\bauth(entication|orization)?\b/i,
  /\bsecurity\b/i,
  /\bprod(uction)?\b/i,
  /\bincident\b/i,
  /\bdata\s+loss\b/i,
  /\bcredential(s)?\b/i,
];

const COMPLEXITY_KEYWORDS = [
  /\brefactor\b/i,
  /\bmigrat(e|ion)\b/i,
  /\bredesign\b/i,
  /\bintegration\b/i,
  /\barchitecture\b/i,
  /\binfrastructure\b/i,
];

// ────────────────────────────────────────────────────────────────
// Cache
// ────────────────────────────────────────────────────────────────

interface CacheEntry {
  hash: string;
  result: TaskDifficultyResult;
}

function getCachePath(repoDir?: string): string {
  const dir = resolve(repoDir || process.cwd(), '.wavemill');
  return join(dir, 'routing-difficulty-cache.jsonl');
}

function readCacheEntry(hash: string, repoDir?: string, ttlDays = DEFAULT_CACHE_TTL_DAYS): TaskDifficultyResult | null {
  const cachePath = getCachePath(repoDir);
  if (!existsSync(cachePath)) {
    return null;
  }

  try {
    const lines = readFileSync(cachePath, 'utf-8').split('\n').filter(Boolean);
    const ttlMs = ttlDays * 24 * 60 * 60 * 1000;
    const now = Date.now();

    for (const line of lines) {
      try {
        const entry: CacheEntry = JSON.parse(line);
        if (entry.hash !== hash) continue;
        const age = now - new Date(entry.result.classifiedAt).getTime();
        if (age <= ttlMs) {
          return { ...entry.result, source: 'cached' };
        }
      } catch {
        // Skip malformed entries
      }
    }
  } catch {
    console.warn('[task-difficulty-classifier] Cache read failed, continuing without cache');
  }

  return null;
}

function writeCacheEntry(hash: string, result: TaskDifficultyResult, repoDir?: string): void {
  const cachePath = getCachePath(repoDir);

  try {
    const dir = resolve(repoDir || process.cwd(), '.wavemill');
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    const entry: CacheEntry = { hash, result };
    const newLine = JSON.stringify(entry) + '\n';

    if (existsSync(cachePath)) {
      const existing = readFileSync(cachePath, 'utf-8').split('\n').filter(Boolean);
      const trimmed = existing.length >= CACHE_MAX_LINES
        ? existing.slice(existing.length - CACHE_MAX_LINES + 1)
        : existing;
      writeFileSync(cachePath, trimmed.join('\n') + '\n' + newLine, 'utf-8');
    } else {
      writeFileSync(cachePath, newLine, 'utf-8');
    }
  } catch {
    console.warn('[task-difficulty-classifier] Cache write failed, continuing without cache');
  }
}

// ────────────────────────────────────────────────────────────────
// Heuristic Fallback
// ────────────────────────────────────────────────────────────────

function classifyByHeuristic(title = '', description = ''): TaskDifficultyResult {
  const text = `${title} ${description}`.trim();

  if (CRITICAL_KEYWORDS.some((re) => re.test(text))) {
    return {
      difficulty: 'critical',
      rationale: 'Contains critical-domain keywords (payment/auth/security/prod/incident/data-loss).',
      source: 'heuristic',
      classifiedAt: new Date().toISOString(),
    };
  }

  const wordCount = text.split(/\s+/).filter(Boolean).length;
  const hasComplexity = COMPLEXITY_KEYWORDS.some((re) => re.test(text));

  if (wordCount < 50 && !hasComplexity) {
    return {
      difficulty: 'trivial',
      rationale: 'Short description with no complexity keywords.',
      source: 'heuristic',
      classifiedAt: new Date().toISOString(),
    };
  }

  if (wordCount >= 150 || hasComplexity) {
    return {
      difficulty: 'hard',
      rationale: hasComplexity
        ? 'Contains refactor/migrate/redesign/integration keywords.'
        : 'Long description (150+ words) suggests broad scope.',
      source: 'heuristic',
      classifiedAt: new Date().toISOString(),
    };
  }

  return {
    difficulty: 'moderate',
    rationale: 'Medium-length description without complexity signals.',
    source: 'heuristic',
    classifiedAt: new Date().toISOString(),
  };
}

// ────────────────────────────────────────────────────────────────
// LLM Classification
// ────────────────────────────────────────────────────────────────

function buildClassificationPrompt(title = '', description = '', packetContent = ''): string {
  const titleSection = title ? `Task Title: ${title}\n\n` : '';
  const descSection = description
    ? `Task Description:\n${description.slice(0, 1500)}\n\n`
    : '';
  const packetSection = packetContent
    ? `Task Packet (excerpt):\n${packetContent.slice(0, 1500)}\n\n`
    : '';

  return `${titleSection}${descSection}${packetSection}Classify this task as one of: trivial, moderate, hard, or critical.

Definitions:
- trivial: Simple, isolated change with minimal risk (e.g., typo fix, rename, small UI tweak)
- moderate: Standard feature with clear scope and limited cross-cutting concerns
- hard: Complex change requiring refactoring, migration, or multiple subsystem coordination
- critical: High-risk domain (payments, auth, security, production data) or severe consequences if wrong

Respond with JSON only:
{"difficulty": "<trivial|moderate|hard|critical>", "rationale": "<one sentence explanation>"}`;
}

function callClassificationModelSync(
  prompt: string,
  model: string,
  repoDir?: string,
): string | null {
  const tmpFile = join(tmpdir(), `wavemill-classify-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`);

  try {
    writeFileSync(tmpFile, prompt, 'utf-8');
    const cliCmd = process.env.CLAUDE_CMD || 'claude';
    const command = `${escapeShellArg(cliCmd)} -p --output-format json --model ${escapeShellArg(model)} < ${escapeShellArg(tmpFile)}`;

    const env = { ...process.env };
    delete env['CLAUDECODE'];

    const raw = execShellCommand(command, {
      encoding: 'utf-8',
      timeout: CLASSIFY_TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
      cwd: repoDir || process.cwd(),
      env,
    });

    // Unwrap JSON envelope (claude CLI --output-format json wraps in { result: ... })
    try {
      const envelope = JSON.parse(raw);
      return (envelope.result || raw).trim();
    } catch {
      return raw.trim();
    }
  } catch {
    return null;
  } finally {
    try {
      if (existsSync(tmpFile)) unlinkSync(tmpFile);
    } catch {
      // Best-effort cleanup
    }
  }
}

function parseLLMClassification(
  text: string,
  title = '',
  description = '',
): TaskDifficultyResult | null {
  // Extract JSON from text
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return null;

  try {
    const parsed = JSON.parse(jsonMatch[0]) as { difficulty?: string; rationale?: string };
    const difficulty = parsed.difficulty as RoutingDifficulty;

    if (!['trivial', 'moderate', 'hard', 'critical'].includes(difficulty)) {
      return null;
    }

    return {
      difficulty,
      rationale: parsed.rationale || 'LLM classification.',
      source: 'llm',
      classifiedAt: new Date().toISOString(),
    };
  } catch {
    return null;
  }
}

// ────────────────────────────────────────────────────────────────
// Main Classifier
// ────────────────────────────────────────────────────────────────

/**
 * Classify a task's difficulty for routing decisions.
 *
 * Uses LLM classification by default (cheapest available model) with a
 * 7-day cache. Falls back to heuristics if LLM is unavailable or skipLlm=true.
 *
 * @param opts - Task metadata and options
 * @returns Classification result with difficulty, rationale, and source
 */
export function classifyTaskDifficulty(opts: ClassifyTaskOptions): TaskDifficultyResult {
  const { title = '', description = '', packetContent = '', repoDir, skipLlm = false, skipCache = false } = opts;
  const model = opts.model || DEFAULT_CLASSIFIER_MODEL;
  const ttlDays = opts.cacheTtlDays ?? DEFAULT_CACHE_TTL_DAYS;

  // 1. Compute content hash for cache key
  const hashInput = `${title}\n${description}\n${(packetContent || '').slice(0, 2000)}`;
  const hash = createHash('sha256').update(hashInput).digest('hex');

  // 2. Check cache
  const cached = skipCache ? null : readCacheEntry(hash, repoDir, ttlDays);
  if (cached) {
    return cached;
  }

  // 3. Heuristic fallback when LLM is skipped
  if (skipLlm) {
    const result = classifyByHeuristic(title, description);
    if (!skipCache) writeCacheEntry(hash, result, repoDir);
    return result;
  }

  // 4. LLM classification
  try {
    const prompt = buildClassificationPrompt(title, description, packetContent);
    const rawResponse = callClassificationModelSync(prompt, model, repoDir);

    if (rawResponse) {
      const llmResult = parseLLMClassification(rawResponse, title, description);
      if (llmResult) {
        if (!skipCache) writeCacheEntry(hash, llmResult, repoDir);
        return llmResult;
      }
    }
  } catch {
    console.warn('[task-difficulty-classifier] LLM classification failed, using heuristic fallback');
  }

  // 5. Heuristic fallback on LLM failure
  console.warn('[task-difficulty-classifier] Falling back to heuristic classification');
  const fallback = classifyByHeuristic(title, description);
  if (!skipCache) writeCacheEntry(hash, fallback, repoDir);
  return fallback;
}

// ────────────────────────────────────────────────────────────────
// Floor Mapping
// ────────────────────────────────────────────────────────────────

/**
 * Get the model quality floor for a given difficulty level.
 *
 * | Difficulty | allowHaiku | preferSonnet | preferOpus | neverHaikuAlone |
 * |------------|-----------|-------------|-----------|----------------|
 * | trivial    | true      | false        | false     | false          |
 * | moderate   | true      | true         | false     | false          |
 * | hard       | false     | true         | false     | true           |
 * | critical   | false     | false        | true      | true           |
 */
export function getAllowedModelFloor(difficulty: RoutingDifficulty): DifficultyFloor {
  switch (difficulty) {
    case 'trivial':
      return { allowHaiku: true, preferSonnet: false, preferOpus: false, neverHaikuAlone: false };
    case 'moderate':
      return { allowHaiku: true, preferSonnet: true, preferOpus: false, neverHaikuAlone: false };
    case 'hard':
      return { allowHaiku: false, preferSonnet: true, preferOpus: false, neverHaikuAlone: true };
    case 'critical':
      return { allowHaiku: false, preferSonnet: false, preferOpus: true, neverHaikuAlone: true };
  }
}

// ────────────────────────────────────────────────────────────────
// Band Mapping
// ────────────────────────────────────────────────────────────────

/**
 * Map an eval-record DifficultyBand to a RoutingDifficulty.
 *
 * | DifficultyBand | RoutingDifficulty |
 * |---------------|------------------|
 * | trivial       | trivial           |
 * | easy          | trivial           |
 * | medium        | moderate          |
 * | hard          | hard              |
 * | very_hard     | critical          |
 */
export function mapDifficultyBandToRouting(band: DifficultyBand): RoutingDifficulty {
  switch (band) {
    case 'trivial':
    case 'easy':
      return 'trivial';
    case 'medium':
      return 'moderate';
    case 'hard':
      return 'hard';
    case 'very_hard':
      return 'critical';
  }
}
