import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseJsonFromLLM } from './llm-cli.ts';

describe('parseJsonFromLLM', () => {
  describe('valid JSON extraction', () => {
    it('parses a plain JSON object', () => {
      assert.deepEqual(parseJsonFromLLM('{ "score": 10 }'), { score: 10 });
    });

    it('parses JSON wrapped in markdown fences', () => {
      assert.deepEqual(parseJsonFromLLM('```json\n{ "score": 10 }\n```'), { score: 10 });
    });

    it('extracts JSON from mixed content', () => {
      assert.deepEqual(parseJsonFromLLM('Here is the result: { "score": 10 } done'), { score: 10 });
    });

    it('handles nested objects and arrays', () => {
      assert.deepEqual(parseJsonFromLLM('{ "outer": { "items": [1, 2, 3] } }'), {
        outer: { items: [1, 2, 3] },
      });
    });

    it('preserves escaped unicode characters', () => {
      assert.deepEqual(parseJsonFromLLM('{ "text": "hello \\u4e16\\u754c" }'), {
        text: 'hello \u4e16\u754c',
      });
    });

    it('allows JavaScript-looking text inside valid JSON strings', () => {
      assert.deepEqual(parseJsonFromLLM('{ "note": "Use => only in code examples" }'), {
        note: 'Use => only in code examples',
      });
    });

    it('allows assignment-looking text inside valid JSON strings', () => {
      assert.deepEqual(parseJsonFromLLM('{ "note": "const result = value" }'), {
        note: 'const result = value',
      });
    });
  });

  describe('JavaScript syntax detection', () => {
    it('rejects JavaScript destructuring syntax', () => {
      assert.throws(
        () => parseJsonFromLLM('{ datasetFile, ...rest }'),
        /JavaScript code instead of JSON/
      );
    });

    it('rejects unquoted property names', () => {
      assert.throws(
        () => parseJsonFromLLM('{ winner: "primary", score: 10 }'),
        /JavaScript code instead of JSON/
      );
    });

    it('rejects spread syntax', () => {
      assert.throws(
        () => parseJsonFromLLM('{ ...config, override: true }'),
        /JavaScript code instead of JSON/
      );
    });

    it('rejects JavaScript variable assignments wrapping JSON', () => {
      assert.throws(
        () => parseJsonFromLLM('const result = { "score": 10 }'),
        /JavaScript code instead of JSON/
      );
    });

    it('rejects arrow functions in invalid JSON candidates', () => {
      assert.throws(
        () => parseJsonFromLLM('{ "fn": () => 10 }'),
        /JavaScript code instead of JSON/
      );
    });
  });

  describe('error handling', () => {
    it('throws on an empty string', () => {
      assert.throws(() => parseJsonFromLLM(''), /Failed to parse JSON from LLM output/);
    });

    it('throws on text with no JSON object', () => {
      assert.throws(() => parseJsonFromLLM('not json at all'), /Failed to parse JSON from LLM output/);
    });

    it('includes a preview in generic parse errors', () => {
      assert.throws(
        () => parseJsonFromLLM('invalid { "broken": true'),
        /First 500 chars:\ninvalid \{ "broken": true/
      );
    });
  });
});
