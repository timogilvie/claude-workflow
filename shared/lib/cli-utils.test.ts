import assert from 'node:assert/strict';
import test from 'node:test';
import { isInteractive } from './cli-utils.ts';

test('isInteractive returns true when stdin is a TTY', () => {
  const original = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');

  Object.defineProperty(process.stdin, 'isTTY', {
    configurable: true,
    value: true,
  });

  try {
    assert.equal(isInteractive(), true);
  } finally {
    restoreIsTTY(original);
  }
});

test('isInteractive returns false when stdin is not a TTY', () => {
  const original = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');

  Object.defineProperty(process.stdin, 'isTTY', {
    configurable: true,
    value: false,
  });

  try {
    assert.equal(isInteractive(), false);
  } finally {
    restoreIsTTY(original);
  }
});

function restoreIsTTY(descriptor: PropertyDescriptor | undefined): void {
  if (descriptor) {
    Object.defineProperty(process.stdin, 'isTTY', descriptor);
    return;
  }

  delete (process.stdin as NodeJS.ReadStream & { isTTY?: boolean }).isTTY;
}
