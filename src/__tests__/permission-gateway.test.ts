import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { PendingPermissions } from '../permission-gateway.js';

describe('PendingPermissions', () => {
  let permissions: PendingPermissions;

  beforeEach(() => {
    permissions = new PendingPermissions(5000);
  });

  afterEach(() => {
    permissions.denyAll();
  });

  it('starts with zero size', () => {
    assert.equal(permissions.size, 0);
  });

  it('tracks pending permission request', async () => {
    const promise = permissions.waitFor('tool-123');
    assert.equal(permissions.size, 1);
    // Resolve it
    permissions.resolve('tool-123', { behavior: 'allow' });
    const result = await promise;
    assert.equal(result.behavior, 'allow');
    assert.equal(permissions.size, 0);
  });

  it('resolves with allow behavior', async () => {
    const promise = permissions.waitFor('tool-allow');
    permissions.resolve('tool-allow', { behavior: 'allow', updatedInput: { key: 'value' } });
    const result = await promise;
    assert.equal(result.behavior, 'allow');
    assert.deepEqual(result.updatedInput, { key: 'value' });
  });

  it('resolves with deny behavior', async () => {
    const promise = permissions.waitFor('tool-deny');
    permissions.resolve('tool-deny', { behavior: 'deny', message: 'Not allowed' });
    const result = await promise;
    assert.equal(result.behavior, 'deny');
    assert.equal(result.message, 'Not allowed');
  });

  it('returns false for non-existent request', () => {
    const result = permissions.resolve('non-existent', { behavior: 'deny' });
    assert.equal(result, false);
  });

  it('clears timer on resolve', async () => {
    const shortTimeout = new PendingPermissions(100);
    shortTimeout.waitFor('tool-fast');
    // Wait a bit but not long enough to timeout
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(shortTimeout.size, 1);
    shortTimeout.resolve('tool-fast', { behavior: 'allow' });
    assert.equal(shortTimeout.size, 0);
  });

  it('denies all pending on shutdown', async () => {
    const p1 = permissions.waitFor('tool-1');
    const p2 = permissions.waitFor('tool-2');
    assert.equal(permissions.size, 2);
    permissions.denyAll();
    assert.equal(permissions.size, 0);
    const r1 = await p1;
    const r2 = await p2;
    assert.equal(r1.behavior, 'deny');
    assert.equal(r2.behavior, 'deny');
    assert.ok(r1.message?.includes('shutting down'));
  });

  it('uses custom timeout', async () => {
    const short = new PendingPermissions(50);
    const p = short.waitFor('tool-short');
    await new Promise((resolve) => setTimeout(resolve, 60));
    const result = await p;
    assert.equal(result.behavior, 'deny');
    assert.ok(result.message?.includes('timed out'));
  });

  it('handles multiple sequential requests', async () => {
    const p1 = permissions.waitFor('tool-a');
    permissions.resolve('tool-a', { behavior: 'allow' });
    await p1;
    assert.equal(permissions.size, 0);

    const p2 = permissions.waitFor('tool-b');
    assert.equal(permissions.size, 1);
    permissions.resolve('tool-b', { behavior: 'deny' });
    const r2 = await p2;
    assert.equal(r2.behavior, 'deny');
  });
});