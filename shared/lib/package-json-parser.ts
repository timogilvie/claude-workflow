/**
 * Package.json parsing utility.
 *
 * Provides a consistent interface for reading and parsing package.json files
 * across the codebase. Handles errors gracefully and returns an empty object
 * when the file is not found or malformed.
 *
 * @module package-json-parser
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Parse package.json from repository directory.
 *
 * Returns an object with dependencies and devDependencies (and other fields),
 * or an empty object if the file is not found or malformed.
 *
 * @param repoDir - Path to the repository directory
 * @returns Parsed package.json object or empty object
 */
export function parsePackageJson(repoDir: string): any {
  const packageJsonPath = join(repoDir, 'package.json');
  if (!existsSync(packageJsonPath)) {
    return {};
  }

  try {
    return JSON.parse(readFileSync(packageJsonPath, 'utf-8'));
  } catch {
    // Malformed package.json - return empty object
    return {};
  }
}
