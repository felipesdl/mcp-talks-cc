import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { redact } from '../src/ingest/redact.ts';

describe('redact', () => {
  it('redacts OpenAI keys', () => {
    const r = redact('use sk-proj-abcdefghijklmnopqrstuvwxyz1234 to call');
    assert.match(r, /<redacted>/);
    assert.doesNotMatch(r, /sk-proj-/);
  });

  it('redacts Bearer tokens', () => {
    const r = redact('Authorization: Bearer eyJabcdefghijklmnop1234567890');
    assert.match(r, /<redacted>/);
    assert.doesNotMatch(r, /eyJabcdefghijklmnop/);
  });

  it('redacts GitHub PATs', () => {
    const r = redact('token ghp_abcdefghijklmnopqrstuvwxyz123456');
    assert.match(r, /<redacted>/);
    assert.doesNotMatch(r, /ghp_/);
  });

  it('redacts env-style secrets', () => {
    const r = redact('API_KEY=abcdef1234567890XYZ');
    assert.match(r, /<redacted>/);
  });

  it('keeps regular text intact', () => {
    const text = 'instalando deps com npm install no projeto web-app';
    assert.equal(redact(text), text);
  });
});
