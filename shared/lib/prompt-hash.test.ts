/**
 * Tests for prompt-hash utilities.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, unlinkSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { hashString, hashFile, createPromptArtifact } from './prompt-hash.ts';

describe('prompt-hash', () => {
  let tempDir: string;
  let tempFilePath: string;

  before(() => {
    // Create a temporary directory for test files
    tempDir = mkdtempSync(join(tmpdir(), 'prompt-hash-test-'));
    tempFilePath = join(tempDir, 'test-template.md');
  });

  after(() => {
    // Clean up temporary files
    try {
      unlinkSync(tempFilePath);
    } catch {
      // Ignore if file doesn't exist
    }
  });

  describe('hashString', () => {
    it('should return consistent hash for same input', () => {
      const input = 'Hello, world!';
      const hash1 = hashString(input);
      const hash2 = hashString(input);

      assert.equal(hash1, hash2);
      assert.equal(hash1.length, 64); // SHA-256 produces 64-char hex string
    });

    it('should return different hashes for different inputs', () => {
      const hash1 = hashString('Hello, world!');
      const hash2 = hashString('Goodbye, world!');

      assert.notEqual(hash1, hash2);
    });

    it('should return known SHA-256 hash for test string', () => {
      // Known SHA-256 hash of "Hello, world!" (verified externally)
      const expected = '315f5bdb76d078c43b8ac0064e4a0164612b1fce77c869345bfc94c75894edd3';
      const actual = hashString('Hello, world!');

      assert.equal(actual, expected);
    });

    it('should handle empty string', () => {
      const hash = hashString('');
      assert.equal(hash.length, 64);
      // Known SHA-256 hash of empty string
      assert.equal(hash, 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    });

    it('should handle multi-line strings', () => {
      const input = 'Line 1\nLine 2\nLine 3';
      const hash = hashString(input);

      assert.equal(hash.length, 64);
      assert.equal(hash, hashString(input)); // Deterministic
    });
  });

  describe('hashFile', () => {
    it('should return consistent hash for same file content', () => {
      const content = 'Test file content';
      writeFileSync(tempFilePath, content, 'utf-8');

      const hash1 = hashFile(tempFilePath);
      const hash2 = hashFile(tempFilePath);

      assert.equal(hash1, hash2);
      assert.equal(hash1.length, 64);
    });

    it('should return same hash as hashString for same content', () => {
      const content = 'Test file content';
      writeFileSync(tempFilePath, content, 'utf-8');

      const fileHash = hashFile(tempFilePath);
      const stringHash = hashString(content);

      assert.equal(fileHash, stringHash);
    });

    it('should return different hash when file content changes', () => {
      writeFileSync(tempFilePath, 'Original content', 'utf-8');
      const hash1 = hashFile(tempFilePath);

      writeFileSync(tempFilePath, 'Modified content', 'utf-8');
      const hash2 = hashFile(tempFilePath);

      assert.notEqual(hash1, hash2);
    });

    it('should throw error for non-existent file', () => {
      assert.throws(() => hashFile('/non/existent/file.txt'));
    });
  });

  describe('createPromptArtifact', () => {
    it('should extract template name from .md file', () => {
      const content = 'Template content';
      writeFileSync(tempFilePath, content, 'utf-8');

      const artifact = createPromptArtifact(tempFilePath, 'Filled prompt');

      assert.equal(artifact.templateName, 'test-template');
    });

    it('should extract template name from .txt file', () => {
      const txtPath = join(tempDir, 'test-template.txt');
      writeFileSync(txtPath, 'Template content', 'utf-8');

      const artifact = createPromptArtifact(txtPath, 'Filled prompt');

      assert.equal(artifact.templateName, 'test-template');

      // Clean up
      unlinkSync(txtPath);
    });

    it('should compute template hash from file content', () => {
      const templateContent = 'Template: {{placeholder}}';
      writeFileSync(tempFilePath, templateContent, 'utf-8');

      const artifact = createPromptArtifact(tempFilePath, 'Filled prompt');

      assert.equal(artifact.templateHash, hashString(templateContent));
      assert.equal(artifact.templateHash.length, 64);
    });

    it('should compute filled prompt hash', () => {
      const templateContent = 'Template content';
      const filledPrompt = 'Template: Actual value';
      writeFileSync(tempFilePath, templateContent, 'utf-8');

      const artifact = createPromptArtifact(tempFilePath, filledPrompt);

      assert.equal(artifact.filledPromptHash, hashString(filledPrompt));
      assert.equal(artifact.filledPromptHash.length, 64);
    });

    it('should create complete artifact with all fields', () => {
      const templateContent = 'Eval judge prompt template';
      const filledPrompt = 'Eval judge prompt with task details';
      writeFileSync(tempFilePath, templateContent, 'utf-8');

      const artifact = createPromptArtifact(tempFilePath, filledPrompt);

      assert.ok(Object.hasOwn(artifact, 'templateName'));
      assert.ok(Object.hasOwn(artifact, 'templateHash'));
      assert.ok(Object.hasOwn(artifact, 'filledPromptHash'));
      assert.equal(artifact.templateName, 'test-template');
      assert.equal(artifact.templateHash.length, 64);
      assert.equal(artifact.filledPromptHash.length, 64);
      assert.notEqual(artifact.templateHash, artifact.filledPromptHash);
    });

    it('should handle eval-judge.md template name correctly', () => {
      const evalJudgePath = join(tempDir, 'eval-judge.md');
      writeFileSync(evalJudgePath, 'Judge template', 'utf-8');

      const artifact = createPromptArtifact(evalJudgePath, 'Filled');

      assert.equal(artifact.templateName, 'eval-judge');

      // Clean up
      unlinkSync(evalJudgePath);
    });

    it('should produce different template hashes for different template versions', () => {
      const version1 = 'Template v1';
      const version2 = 'Template v2';
      const filledPrompt = 'Same filled prompt';

      writeFileSync(tempFilePath, version1, 'utf-8');
      const artifact1 = createPromptArtifact(tempFilePath, filledPrompt);

      writeFileSync(tempFilePath, version2, 'utf-8');
      const artifact2 = createPromptArtifact(tempFilePath, filledPrompt);

      assert.notEqual(artifact1.templateHash, artifact2.templateHash);
      assert.equal(artifact1.filledPromptHash, artifact2.filledPromptHash); // Same filled prompt
    });
  });
});
