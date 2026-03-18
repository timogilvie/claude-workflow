/**
 * Prompt artifact hashing utilities for GEPA training signal attribution.
 *
 * Provides functions to compute SHA-256 hashes of prompt templates and filled
 * prompts, enabling tracking of which prompt version produced which eval result.
 *
 * @module prompt-hash
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';

/**
 * A prompt artifact capturing template and filled prompt hashes.
 *
 * Used to track which prompt template version was used during workflow
 * execution, enabling attribution of eval performance to specific prompt
 * artifacts for GEPA training.
 */
export interface PromptArtifact {
  /** Template name (e.g., "issue-writer", "eval-judge") */
  templateName: string;
  /** SHA-256 hash of the template file at time of use */
  templateHash: string;
  /** SHA-256 hash of the filled prompt sent to LLM */
  filledPromptHash: string;
}

/**
 * Compute SHA-256 hash of a string.
 *
 * @param content - The string content to hash
 * @returns Hex-encoded SHA-256 hash
 *
 * @example
 * ```ts
 * const hash = hashString("Hello, world!");
 * // Returns: "315f5bdb76d078c43b8ac0064e4a0164612b1fce77c869345bfc94c75894edd3"
 * ```
 */
export function hashString(content: string): string {
  return createHash('sha256').update(content, 'utf-8').digest('hex');
}

/**
 * Compute SHA-256 hash of a file's content.
 *
 * @param filePath - Absolute path to the file to hash
 * @returns Hex-encoded SHA-256 hash of the file content
 * @throws {Error} If the file cannot be read
 *
 * @example
 * ```ts
 * const hash = hashFile("/path/to/template.md");
 * // Returns: "a1b2c3d4..."
 * ```
 */
export function hashFile(filePath: string): string {
  const content = readFileSync(filePath, 'utf-8');
  return hashString(content);
}

/**
 * Create a prompt artifact from a template file and filled prompt.
 *
 * Extracts the template name from the file path, computes hashes for both
 * the template file and the filled prompt, and returns a structured artifact.
 *
 * @param templatePath - Absolute path to the template file (e.g., "/path/to/eval-judge.md")
 * @param filledPrompt - The filled prompt string that was sent to the LLM
 * @returns A structured prompt artifact with template name and hashes
 * @throws {Error} If the template file cannot be read
 *
 * @example
 * ```ts
 * const artifact = createPromptArtifact(
 *   "/tools/prompts/eval-judge.md",
 *   "Evaluate this PR: ..."
 * );
 * // Returns:
 * // {
 * //   templateName: "eval-judge",
 * //   templateHash: "a1b2c3d4...",
 * //   filledPromptHash: "e5f6g7h8..."
 * // }
 * ```
 */
export function createPromptArtifact(
  templatePath: string,
  filledPrompt: string,
): PromptArtifact {
  // Extract template name from file path (e.g., "eval-judge.md" → "eval-judge")
  const filename = basename(templatePath);
  const templateName = filename.replace(/\.(md|txt)$/, '');

  // Hash the template file content
  const templateHash = hashFile(templatePath);

  // Hash the filled prompt
  const filledPromptHash = hashString(filledPrompt);

  return {
    templateName,
    templateHash,
    filledPromptHash,
  };
}
