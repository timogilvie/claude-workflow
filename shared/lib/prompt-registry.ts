/**
 * Prompt Template Version Registry
 *
 * Logs prompt template usage to `.wavemill/evals/prompt-registry.jsonl` for
 * GEPA (Gradient-based Executable Prompt Adaptation) training attribution.
 * Each registry entry captures the template name, hash, timestamp, and content
 * snapshot (for new versions only).
 *
 * ## Design
 *
 * - **Deduplication**: Only logs new template versions (by hash)
 * - **Atomic writes**: Uses temp file + rename pattern for safety
 * - **Graceful degradation**: Registry failures don't break workflows
 * - **Space efficient**: Content snapshot only stored once per hash
 *
 * @module prompt-registry
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { basename, join, resolve } from 'node:path';
import { hashString } from './prompt-hash.ts';
import { loadWavemillConfig } from './config.ts';

// ────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────

/**
 * A registry entry capturing a prompt template version.
 *
 * Stored in `.wavemill/evals/prompt-registry.jsonl` for GEPA training.
 */
export interface PromptRegistryEntry {
  /** Template name (e.g., "issue-writer", "eval-judge") */
  templateName: string;

  /** SHA-256 hash of template content */
  templateHash: string;

  /** ISO 8601 timestamp when template was used */
  timestamp: string;

  /** Template content snapshot (only for new hash values) */
  templateContent?: string;
}

/** Options for registry operations. */
export interface RegistryOptions {
  /** Override directory for registry storage. Resolved relative to cwd. */
  dir?: string;
}

// ────────────────────────────────────────────────────────────────
// Constants
// ────────────────────────────────────────────────────────────────

const DEFAULT_EVALS_DIR = '.wavemill/evals';
const REGISTRY_FILENAME = 'prompt-registry.jsonl';

// ────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────

/**
 * Resolve the evals directory, reading from `.wavemill-config.json` if
 * no explicit `dir` is provided.
 */
function resolveEvalsDir(dir?: string): string {
  if (dir) return resolve(dir);

  // Try reading evalsDir from .wavemill-config.json
  const config = loadWavemillConfig();
  if (config.eval?.evalsDir) {
    return resolve(config.eval.evalsDir);
  }

  return resolve(DEFAULT_EVALS_DIR);
}

/** Resolve the full path to the registry JSONL file. */
function resolveRegistryFile(dir?: string): string {
  return join(resolveEvalsDir(dir), REGISTRY_FILENAME);
}

/**
 * Extract template name from file path.
 *
 * @example
 * ```ts
 * extractTemplateName("/tools/prompts/issue-writer.md")
 * // Returns: "issue-writer"
 * ```
 */
function extractTemplateName(templatePath: string): string {
  const filename = basename(templatePath);
  return filename.replace(/\.(md|txt)$/, '');
}

/**
 * Check if a hash already exists in the registry.
 *
 * Reads the registry file and checks if any entry has the given hash.
 * Returns false if the registry doesn't exist yet.
 */
function hashExistsInRegistry(
  hash: string,
  registryPath: string,
): boolean {
  if (!existsSync(registryPath)) {
    return false;
  }

  try {
    const content = readFileSync(registryPath, 'utf-8');
    const lines = content.trim().split('\n').filter(Boolean);

    for (const line of lines) {
      try {
        const entry = JSON.parse(line) as PromptRegistryEntry;
        if (entry.templateHash === hash) {
          return true;
        }
      } catch {
        // Skip malformed lines
        continue;
      }
    }

    return false;
  } catch {
    // If we can't read the file, assume hash doesn't exist
    return false;
  }
}

/**
 * Append an entry to the registry using atomic write pattern.
 *
 * Uses temp file + rename to ensure the registry isn't corrupted if
 * the write is interrupted.
 */
function appendToRegistry(
  entry: PromptRegistryEntry,
  registryPath: string,
): void {
  const evalsDir = resolve(registryPath, '..');
  const line = JSON.stringify(entry) + '\n';

  // Atomic append: read existing, add line, write via temp file + rename
  const tmpPath = join(evalsDir, `.prompt-registry-${randomUUID()}.tmp`);

  let existing = '';
  if (existsSync(registryPath)) {
    existing = readFileSync(registryPath, 'utf-8');
  }

  writeFileSync(tmpPath, existing + line, 'utf-8');
  renameSync(tmpPath, registryPath);
}

// ────────────────────────────────────────────────────────────────
// Public API
// ────────────────────────────────────────────────────────────────

/**
 * Log a prompt template usage to the registry.
 *
 * Only logs if the template hash hasn't been seen before (deduplication).
 * Stores the full template content for new hashes, omits it for known hashes.
 *
 * This function is safe to call frequently - it won't bloat the registry
 * with duplicate entries. Registry failures are caught and logged as warnings
 * (graceful degradation).
 *
 * @param templatePath - Path to the template file (used for name extraction)
 * @param templateContent - The template content to hash and optionally store
 * @param options - Optional directory override
 *
 * @example
 * ```typescript
 * const template = await readFile("tools/prompts/issue-writer.md", "utf-8");
 * logPromptUsage("tools/prompts/issue-writer.md", template);
 * ```
 */
export function logPromptUsage(
  templatePath: string,
  templateContent: string,
  options?: RegistryOptions,
): void {
  try {
    const evalsDir = resolveEvalsDir(options?.dir);
    const registryPath = resolveRegistryFile(options?.dir);

    // Ensure directory exists
    mkdirSync(evalsDir, { recursive: true });

    // Compute hash and check if it's already in the registry
    const templateHash = hashString(templateContent);
    const isNewHash = !hashExistsInRegistry(templateHash, registryPath);

    // Extract template name from path
    const templateName = extractTemplateName(templatePath);

    // Build registry entry
    const entry: PromptRegistryEntry = {
      templateName,
      templateHash,
      timestamp: new Date().toISOString(),
    };

    // Only include content for new hashes (saves space)
    if (isNewHash) {
      entry.templateContent = templateContent;
    }

    // Append to registry
    appendToRegistry(entry, registryPath);
  } catch (err) {
    // Graceful degradation: registry is metadata, shouldn't break workflows
    console.warn(`[prompt-registry] Failed to log template usage: ${err}`);
  }
}

/**
 * Load a template file and register its usage.
 *
 * Convenience function that combines file reading with registry logging.
 * Registry failures won't prevent the template from being returned.
 *
 * @param templatePath - Path to the template file
 * @param options - Optional directory override
 * @returns The template content
 * @throws {Error} If the template file cannot be read
 *
 * @example
 * ```typescript
 * const template = await loadAndRegisterTemplate("tools/prompts/eval-judge.md");
 * ```
 */
export async function loadAndRegisterTemplate(
  templatePath: string,
  options?: RegistryOptions,
): Promise<string> {
  const content = readFileSync(templatePath, 'utf-8');

  // Log usage (failures are caught internally)
  logPromptUsage(templatePath, content, options);

  return content;
}
