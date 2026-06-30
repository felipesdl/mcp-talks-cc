import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { chunkText } from '../src/ingest/chunker.ts';
import { config } from '../src/config.ts';

describe('chunker', () => {
  it('returns empty for text below minChars', () => {
    const out = chunkText('hi');
    assert.equal(out.length, 0);
  });

  it('returns single chunk for short text within size', () => {
    const text = 'a'.repeat(200);
    const out = chunkText(text);
    assert.equal(out.length, 1);
    assert.equal(out[0]!.length, 200);
  });

  it('splits long text into multiple chunks', () => {
    const text = 'palavra '.repeat(500); // ~4000 chars
    const out = chunkText(text);
    assert.ok(out.length > 1);
    // each chunk should be at most size + overlap (since overlap prepends to next)
    for (const c of out) {
      assert.ok(c.length <= config.chunk.size + config.chunk.overlap);
    }
  });

  it('applies overlap between consecutive chunks', () => {
    const text = 'a'.repeat(2000);
    const out = chunkText(text);
    if (out.length < 2) return;
    const tailOfFirst = out[0]!.slice(-config.chunk.overlap);
    const headOfSecond = out[1]!.slice(0, config.chunk.overlap);
    assert.equal(tailOfFirst, headOfSecond);
  });
});
