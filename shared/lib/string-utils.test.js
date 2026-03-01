import assert from 'assert';
import { toKebabCase } from './string-utils.js';

// Basic conversion
assert.strictEqual(toKebabCase('Hello World'), 'hello-world');
assert.strictEqual(toKebabCase('hello-world'), 'hello-world');

// Special characters
assert.strictEqual(toKebabCase('Add User!!! Auth'), 'add-user-auth');
assert.strictEqual(toKebabCase('Add User Authentication System!!! with spaces'), 'add-user-authentication-system-with-spaces');

// Leading/trailing special chars
assert.strictEqual(toKebabCase('--test--'), 'test');
assert.strictEqual(toKebabCase('!!!hello!!!'), 'hello');

// Multiple consecutive special chars
assert.strictEqual(toKebabCase('foo___bar___baz'), 'foo-bar-baz');

// Max length without truncation
assert.strictEqual(toKebabCase('hello', 10), 'hello');
assert.strictEqual(toKebabCase('hello-world', 20), 'hello-world');

// Max length with truncation
assert.strictEqual(toKebabCase('very long name here', 10), 'very-long');
assert.strictEqual(toKebabCase('hello-world-foo', 11), 'hello-world');

// Max length edge case: ensure no trailing dash after truncation
assert.strictEqual(toKebabCase('hello-world-extra', 12), 'hello-world');
assert.strictEqual(toKebabCase('a-b-c-d-e-f-g', 5), 'a-b-c');

// Empty and edge cases
assert.strictEqual(toKebabCase(''), '');
assert.strictEqual(toKebabCase('!!!'), '');
assert.strictEqual(toKebabCase('123'), '123');

console.log('string-utils.test.js passed');
