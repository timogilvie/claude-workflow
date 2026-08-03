/**
 * Atomic artifact write utilities using the temp-file + atomic-rename pattern.
 * Prevents corruption from concurrent writes or unexpected termination.
 */

import { writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';

/**
 * Write a JSON artifact atomically to a file path.
 *
 * Pattern:
 * 1. Create parent directories
 * 2. Serialize data to JSON
 * 3. Write to temp file (includes random suffix to avoid collisions)
 * 4. Atomically rename temp to target (atomic at OS level)
 *
 * This ensures:
 * - Concurrent writers don't corrupt each other
 * - Incomplete writes don't overwrite valid artifacts
 * - On crash, temp files can be cleaned up without affecting valid data
 *
 * @param filePath - Target file path
 * @param data - Data to serialize and write
 * @throws On JSON serialization or I/O errors
 */
export async function writeArtifactAtomic(
  filePath: string,
  data: unknown,
): Promise<void> {
  const dir = dirname(filePath);
  const filename = filePath.split('/').pop();
  const randomSuffix = randomBytes(4).toString('hex');
  const tempFile = join(dir, `.${filename}.${randomSuffix}.tmp`);

  try {
    // Ensure parent directory exists
    mkdirSync(dir, { recursive: true });

    // Serialize to JSON
    const jsonString = JSON.stringify(data, null, 2);

    // Write to temp file
    writeFileSync(tempFile, jsonString, 'utf-8');

    // Atomically rename (atomic at OS level)
    renameSync(tempFile, filePath);
  } catch (err) {
    // Best-effort cleanup of temp file on error
    try {
      require('fs').unlinkSync(tempFile);
    } catch {
      // Ignore cleanup errors
    }
    throw err;
  }
}

/**
 * Synchronous version of writeArtifactAtomic.
 * Use when async is not available (e.g., in sync contexts).
 *
 * @param filePath - Target file path
 * @param data - Data to serialize and write
 */
export function writeArtifactAtomicSync(
  filePath: string,
  data: unknown,
): void {
  const dir = dirname(filePath);
  const filename = filePath.split('/').pop();
  const randomSuffix = randomBytes(4).toString('hex');
  const tempFile = join(dir, `.${filename}.${randomSuffix}.tmp`);

  try {
    // Ensure parent directory exists
    mkdirSync(dir, { recursive: true });

    // Serialize to JSON
    const jsonString = JSON.stringify(data, null, 2);

    // Write to temp file
    writeFileSync(tempFile, jsonString, 'utf-8');

    // Atomically rename
    renameSync(tempFile, filePath);
  } catch (err) {
    // Best-effort cleanup of temp file on error
    try {
      require('fs').unlinkSync(tempFile);
    } catch {
      // Ignore cleanup errors
    }
    throw err;
  }
}
