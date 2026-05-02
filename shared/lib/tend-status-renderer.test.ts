import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createStatusRenderer } from './tend-status-renderer.ts';

describe('StatusRenderer', () => {
  interface FakeStream {
    isTTY: boolean;
    writes: string[];
    write(chunk: string): void;
  }

  function createFakeStream(isTTY: boolean): FakeStream {
    return {
      isTTY,
      writes: [],
      write(chunk: string) {
        this.writes.push(chunk);
      },
    };
  }

  it('TTY: identical lines → in-place rewrite', () => {
    const stream = createFakeStream(true);
    const renderer = createStatusRenderer(stream as any);

    renderer.write('A');
    renderer.write('A');
    renderer.write('A');

    assert.deepEqual(stream.writes, ['A', '\r\x1b[KA', '\r\x1b[KA']);
  });

  it('TTY: status change → new line', () => {
    const stream = createFakeStream(true);
    const renderer = createStatusRenderer(stream as any);

    renderer.write('A');
    renderer.write('A');
    renderer.write('B');
    renderer.write('B');
    renderer.write('A');

    assert.deepEqual(stream.writes, ['A', '\r\x1b[KA', '\nB', '\r\x1b[KB', '\nA']);
  });

  it('Non-TTY: one line per call', () => {
    const stream = createFakeStream(false);
    const renderer = createStatusRenderer(stream as any);

    renderer.write('A');
    renderer.write('A');
    renderer.write('B');

    assert.deepEqual(stream.writes, ['A\n', 'A\n', 'B\n']);
  });

  it('finalize() emits exactly one newline', () => {
    const stream = createFakeStream(true);
    const renderer = createStatusRenderer(stream as any);

    renderer.write('A');
    renderer.finalize();
    renderer.finalize();

    assert.deepEqual(stream.writes, ['A', '\n']);
  });

  it('TTY: finalize() after loop exit appends newline', () => {
    const stream = createFakeStream(true);
    const renderer = createStatusRenderer(stream as any);

    renderer.write('A');
    renderer.finalize();

    assert.deepEqual(stream.writes, ['A', '\n']);
  });

  it('Non-TTY: finalize() with no prior writes emits newline', () => {
    const stream = createFakeStream(false);
    const renderer = createStatusRenderer(stream as any);

    renderer.finalize();

    assert.deepEqual(stream.writes, ['\n']);
  });

  it('TTY: stream without isTTY property defaults to false', () => {
    const stream = { writes: [] } as any;
    stream.write = function (chunk: string) {
      this.writes.push(chunk);
    };
    const renderer = createStatusRenderer(stream);

    renderer.write('A');
    renderer.write('A');

    assert.deepEqual(stream.writes, ['A\n', 'A\n']);
  });
});
