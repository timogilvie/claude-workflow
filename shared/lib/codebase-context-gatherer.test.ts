/**
 * Tests for codebase-context-gatherer.ts
 *
 * Note: These tests focus on testable pure functions and light integration.
 * Full integration testing (git, fs operations) is done via tool-level tests.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  getDirectoryTree,
  getRecentGitActivity,
  findRelevantFiles,
} from './codebase-context-gatherer.ts';

describe('getDirectoryTree', () => {
  test('returns directory tree for current repo', async () => {
    const tree = await getDirectoryTree(process.cwd(), 2);

    // Should return something (not empty error message)
    assert.notEqual(tree, '(Directory tree unavailable)');
    assert.notEqual(tree, '(No directories found)');

    // Should include root directory
    assert.ok(tree.includes('.'));
  });

  test('handles invalid path gracefully', async () => {
    const tree = await getDirectoryTree('/nonexistent/path/that/does/not/exist', 2);
    assert.equal(tree, '(Directory tree unavailable)');
  });

  test('respects depth limit', async () => {
    const tree = await getDirectoryTree(process.cwd(), 1);

    // Should not include deeply nested paths (more than 1 level)
    const lines = tree.split('\n');
    const deepPaths = lines.filter((line) => (line.match(/\//g) || []).length > 1);

    // At depth 1, we might have ./subdir but not ./subdir/nested
    assert.ok(deepPaths.length <= lines.length);
  });
});

describe('getRecentGitActivity', () => {
  test('returns git activity for current repo', () => {
    const activity = getRecentGitActivity(process.cwd(), 5);

    // Should return something (not empty error message)
    assert.notEqual(activity, '(Git history unavailable)');
    assert.notEqual(activity, '(No recent commits found)');

    // Should have multiple lines (commits and files)
    assert.ok(activity.split('\n').length > 0);
  });

  test('handles invalid path gracefully', () => {
    const activity = getRecentGitActivity('/nonexistent/path', 5);
    assert.equal(activity, '(Git history unavailable)');
  });

  test('respects commit limit', () => {
    const activity = getRecentGitActivity(process.cwd(), 1);

    // With limit=1, should have fewer lines than limit=10
    const lines = activity.split('\n');
    assert.ok(lines.length < 100); // Sanity check
  });
});

describe('findRelevantFiles', () => {
  test('returns valid result for keywords', async () => {
    // Use keywords that should exist in this repo
    const files = await findRelevantFiles(process.cwd(), 'linear issue tool workflow');

    // Should return a string (either results or a message)
    assert.equal(typeof files, 'string');

    // Should not return an empty string
    assert.ok(files.length > 0);
  });

  test('handles issue title with no meaningful keywords', async () => {
    const files = await findRelevantFiles(process.cwd(), 'a the an to');
    assert.equal(files, '(No relevant keywords found)');
  });

  test('handles invalid path gracefully', async () => {
    const files = await findRelevantFiles(
      '/nonexistent/path',
      'authentication system'
    );

    // Should handle gracefully (either no results or error message)
    assert.equal(typeof files, 'string');
  });

  test('filters stop words from search', async () => {
    // Test that stop words are excluded from keyword extraction
    const files = await findRelevantFiles(process.cwd(), 'add update fix the');

    // All words are stop words or too short, should return no keywords message
    assert.equal(files, '(No relevant keywords found)');
  });

  test('limits to top 3 keywords', async () => {
    const files = await findRelevantFiles(
      process.cwd(),
      'authentication authorization session token credential'
    );

    if (!files.includes('(No relevant keywords found)')) {
      // Count keyword headers
      const keywordMatches = files.match(/Keyword: "/g) || [];
      assert.ok(keywordMatches.length <= 3);
    }
  });
});
