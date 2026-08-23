/**
 * Tests for prompt-hash utilities.
 */

import { after as afterAll, before as beforeAll, describe, test as it } from 'node:test';
import { expect } from './test-assertions.ts';
import { writeFileSync, unlinkSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { hashString, hashFile, createPromptArtifact } from './prompt-hash.ts';

describe('prompt-hash', () => {
  let tempDir: string;
  let tempFilePath: string;

  beforeAll(() => {
    // Create a temporary directory for test files
    tempDir = mkdtempSync(join(tmpdir(), 'prompt-hash-test-'));
    tempFilePath = join(tempDir, 'test-template.md');
  });

  afterAll(() => {
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

      expect(hash1).toBe(hash2);
      expect(hash1).toHaveLength(64); // SHA-256 produces 64-char hex string
    });

    it('should return different hashes for different inputs', () => {
      const hash1 = hashString('Hello, world!');
      const hash2 = hashString('Goodbye, world!');

      expect(hash1).not.toBe(hash2);
    });

    it('should return known SHA-256 hash for test string', () => {
      // Known SHA-256 hash of "Hello, world!" (verified externally)
      const expected = '315f5bdb76d078c43b8ac0064e4a0164612b1fce77c869345bfc94c75894edd3';
      const actual = hashString('Hello, world!');

      expect(actual).toBe(expected);
    });

    it('should handle empty string', () => {
      const hash = hashString('');
      expect(hash).toHaveLength(64);
      // Known SHA-256 hash of empty string
      expect(hash).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    });

    it('should handle multi-line strings', () => {
      const input = 'Line 1\nLine 2\nLine 3';
      const hash = hashString(input);

      expect(hash).toHaveLength(64);
      expect(hash).toBe(hashString(input)); // Deterministic
    });
  });

  describe('hashFile', () => {
    it('should return consistent hash for same file content', () => {
      const content = 'Test file content';
      writeFileSync(tempFilePath, content, 'utf-8');

      const hash1 = hashFile(tempFilePath);
      const hash2 = hashFile(tempFilePath);

      expect(hash1).toBe(hash2);
      expect(hash1).toHaveLength(64);
    });

    it('should return same hash as hashString for same content', () => {
      const content = 'Test file content';
      writeFileSync(tempFilePath, content, 'utf-8');

      const fileHash = hashFile(tempFilePath);
      const stringHash = hashString(content);

      expect(fileHash).toBe(stringHash);
    });

    it('should return different hash when file content changes', () => {
      writeFileSync(tempFilePath, 'Original content', 'utf-8');
      const hash1 = hashFile(tempFilePath);

      writeFileSync(tempFilePath, 'Modified content', 'utf-8');
      const hash2 = hashFile(tempFilePath);

      expect(hash1).not.toBe(hash2);
    });

    it('should throw error for non-existent file', () => {
      expect(() => hashFile('/non/existent/file.txt')).toThrow();
    });
  });

  describe('createPromptArtifact', () => {
    it('should extract template name from .md file', () => {
      const content = 'Template content';
      writeFileSync(tempFilePath, content, 'utf-8');

      const artifact = createPromptArtifact(tempFilePath, 'Filled prompt');

      expect(artifact.templateName).toBe('test-template');
    });

    it('should extract template name from .txt file', () => {
      const txtPath = join(tempDir, 'test-template.txt');
      writeFileSync(txtPath, 'Template content', 'utf-8');

      const artifact = createPromptArtifact(txtPath, 'Filled prompt');

      expect(artifact.templateName).toBe('test-template');

      // Clean up
      unlinkSync(txtPath);
    });

    it('should compute template hash from file content', () => {
      const templateContent = 'Template: {{placeholder}}';
      writeFileSync(tempFilePath, templateContent, 'utf-8');

      const artifact = createPromptArtifact(tempFilePath, 'Filled prompt');

      expect(artifact.templateHash).toBe(hashString(templateContent));
      expect(artifact.templateHash).toHaveLength(64);
    });

    it('should compute filled prompt hash', () => {
      const templateContent = 'Template content';
      const filledPrompt = 'Template: Actual value';
      writeFileSync(tempFilePath, templateContent, 'utf-8');

      const artifact = createPromptArtifact(tempFilePath, filledPrompt);

      expect(artifact.filledPromptHash).toBe(hashString(filledPrompt));
      expect(artifact.filledPromptHash).toHaveLength(64);
    });

    it('should create complete artifact with all fields', () => {
      const templateContent = 'Eval judge prompt template';
      const filledPrompt = 'Eval judge prompt with task details';
      writeFileSync(tempFilePath, templateContent, 'utf-8');

      const artifact = createPromptArtifact(tempFilePath, filledPrompt);

      expect(artifact).toHaveProperty('templateName');
      expect(artifact).toHaveProperty('templateHash');
      expect(artifact).toHaveProperty('filledPromptHash');
      expect(artifact.templateName).toBe('test-template');
      expect(artifact.templateHash).toHaveLength(64);
      expect(artifact.filledPromptHash).toHaveLength(64);
      expect(artifact.templateHash).not.toBe(artifact.filledPromptHash);
    });

    it('should handle eval-judge.md template name correctly', () => {
      const evalJudgePath = join(tempDir, 'eval-judge.md');
      writeFileSync(evalJudgePath, 'Judge template', 'utf-8');

      const artifact = createPromptArtifact(evalJudgePath, 'Filled');

      expect(artifact.templateName).toBe('eval-judge');

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

      expect(artifact1.templateHash).not.toBe(artifact2.templateHash);
      expect(artifact1.filledPromptHash).toBe(artifact2.filledPromptHash); // Same filled prompt
    });
  });
});
