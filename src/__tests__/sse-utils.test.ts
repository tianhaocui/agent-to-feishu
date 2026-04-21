import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { sseEvent } from '../sse-utils.js';

describe('sseEvent', () => {
  it('formats simple event with type and data', () => {
    const result = sseEvent('message', { text: 'hello' });
    const expected = 'data: {"type":"message","data":{"text":"hello"}}\n';
    assert.equal(result, expected);
  });

  it('serializes complex data objects', () => {
    const data = { users: [{ id: 'u1' }, { id: 'u2' }] };
    const result = sseEvent('users', data);
    assert.ok(result.includes('"type":"users"'));
    assert.ok(result.includes('"data"'));
  });

  it('escapes special characters in data', () => {
    const result = sseEvent('test', { msg: 'line1\nline2' });
    // JSON.stringify handles the escaping
    assert.ok(result.includes('\\n'));
  });

  it('handles null data', () => {
    const result = sseEvent('empty', null);
    assert.ok(result.includes('"type":"empty"'));
    assert.ok(result.includes('"data":null'));
  });

  it('handles boolean data', () => {
    const result = sseEvent('flag', true);
    assert.ok(result.includes('"data":true'));
  });

  it('handles number data', () => {
    const result = sseEvent('count', 42);
    assert.ok(result.includes('"data":42'));
  });
});