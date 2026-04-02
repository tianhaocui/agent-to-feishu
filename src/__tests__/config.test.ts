import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { maskSecret, configToSettings, type Config } from '../config.js';

// ── maskSecret ──

describe('maskSecret', () => {
  it('masks short values entirely', () => {
    assert.equal(maskSecret('abc'), '****');
    assert.equal(maskSecret('abcd'), '****');
    assert.equal(maskSecret(''), '****');
  });

  it('preserves last 4 chars for longer values', () => {
    assert.equal(maskSecret('12345678'), '****5678');
    assert.equal(maskSecret('secret-token-abcd'), '*************abcd');
  });

  it('handles exactly 5 chars', () => {
    assert.equal(maskSecret('12345'), '*2345');
  });
});

// ── configToSettings ──

describe('configToSettings', () => {
  const base: Config = {
    runtime: 'claude',
    enabledChannels: [],
    defaultWorkDir: '/tmp/test',
    defaultMode: 'code',
  };

  it('always sets remote_bridge_enabled to true', () => {
    const m = configToSettings(base);
    assert.equal(m.get('remote_bridge_enabled'), 'true');
  });

  it('sets feishu enabled flag based on enabledChannels', () => {
    const m = configToSettings({ ...base, enabledChannels: ['feishu'] });
    assert.equal(m.get('bridge_feishu_enabled'), 'true');
  });

  it('maps feishu config', () => {
    const m = configToSettings({
      ...base,
      enabledChannels: ['feishu'],
      feishuAppId: 'app-id',
      feishuAppSecret: 'app-secret',
      feishuDomain: 'example.com',
      feishuAllowedUsers: ['fu1'],
    });
    assert.equal(m.get('bridge_feishu_app_id'), 'app-id');
    assert.equal(m.get('bridge_feishu_app_secret'), 'app-secret');
    assert.equal(m.get('bridge_feishu_domain'), 'example.com');
    assert.equal(m.get('bridge_feishu_allowed_users'), 'fu1');
  });

  it('maps workdir and mode, omits model when not set', () => {
    const m = configToSettings(base);
    assert.equal(m.get('bridge_default_work_dir'), '/tmp/test');
    assert.equal(m.has('bridge_default_model'), false);
    assert.equal(m.has('default_model'), false);
    assert.equal(m.get('bridge_default_mode'), 'code');
  });

  it('maps model when explicitly set', () => {
    const m = configToSettings({ ...base, defaultModel: 'gpt-4o' });
    assert.equal(m.get('bridge_default_model'), 'gpt-4o');
    assert.equal(m.get('default_model'), 'gpt-4o');
  });

  it('maps non-default mode', () => {
    const m = configToSettings({ ...base, defaultMode: 'plan' });
    assert.equal(m.get('bridge_default_mode'), 'plan');
  });

  it('omits optional fields when not set', () => {
    const m = configToSettings(base);
    assert.equal(m.has('bridge_feishu_app_id'), false);
  });
});

// ── Config file parsing (loadConfig/saveConfig round-trip) ──

describe('loadConfig/saveConfig round-trip', () => {
  let tmpDir: string;
  let origHome: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-config-test-'));
    origHome = process.env.HOME || '';
  });

  afterEach(() => {
    process.env.HOME = origHome;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('configToSettings returns correct defaults', () => {
    const m = configToSettings({
      runtime: 'claude',
      enabledChannels: [],
      defaultWorkDir: process.cwd(),
      defaultMode: 'code',
    });
    assert.equal(m.get('bridge_feishu_enabled'), 'false');
  });
});