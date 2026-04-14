/**
 * Encrypted token storage for OAuth user_access_token.
 * AES-256-GCM with random master key, stored under ${CTI_HOME}/oauth/.
 *
 * Ported from openclaw-lark (MIT), Linux-only simplified version.
 */

import { randomBytes, createCipheriv, createDecipheriv } from 'crypto';
import { readFileSync, writeFileSync, mkdirSync, unlinkSync, existsSync } from 'fs';
import { join } from 'path';

export interface StoredUAToken {
  userOpenId: string;
  appId: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  refreshExpiresAt: number;
  scope: string;
  grantedAt: number;
}

const REFRESH_AHEAD_MS = 5 * 60 * 1000; // refresh 5 min before expiry

export function tokenStatus(token: StoredUAToken): 'valid' | 'needs_refresh' | 'expired' {
  const now = Date.now();
  if (now < token.expiresAt - REFRESH_AHEAD_MS) return 'valid';
  if (now < token.refreshExpiresAt - REFRESH_AHEAD_MS) return 'needs_refresh';
  return 'expired';
}

function getOAuthDir(ctiHome: string): string {
  const dir = join(ctiHome, 'oauth');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

function getMasterKey(ctiHome: string): Buffer {
  const dir = getOAuthDir(ctiHome);
  const keyPath = join(dir, 'master.key');
  if (existsSync(keyPath)) {
    return readFileSync(keyPath);
  }
  const key = randomBytes(32);
  writeFileSync(keyPath, key, { mode: 0o600 });
  return key;
}

function tokenPath(ctiHome: string, appId: string, userOpenId: string): string {
  return join(getOAuthDir(ctiHome), `${appId}_${userOpenId}.enc`);
}

function encrypt(key: Buffer, data: string): Buffer {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(data, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]); // 12 + 16 + N
}

function decrypt(key: Buffer, buf: Buffer): string {
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const encrypted = buf.subarray(28);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
}

export function getStoredToken(ctiHome: string, appId: string, userOpenId: string): StoredUAToken | null {
  const path = tokenPath(ctiHome, appId, userOpenId);
  if (!existsSync(path)) return null;
  try {
    const key = getMasterKey(ctiHome);
    const buf = readFileSync(path);
    const json = decrypt(key, buf);
    return JSON.parse(json) as StoredUAToken;
  } catch (err) {
    console.warn('[token-store] Failed to read token:', err instanceof Error ? err.message : err);
    return null;
  }
}

export function setStoredToken(ctiHome: string, token: StoredUAToken): void {
  try {
    const key = getMasterKey(ctiHome);
    const encrypted = encrypt(key, JSON.stringify(token));
    writeFileSync(tokenPath(ctiHome, token.appId, token.userOpenId), encrypted, { mode: 0o600 });
    console.log(`[token-store] Token saved for ${token.appId}:${token.userOpenId}`);
  } catch (err) {
    console.warn('[token-store] Failed to save token:', err instanceof Error ? err.message : err);
  }
}

export function removeStoredToken(ctiHome: string, appId: string, userOpenId: string): void {
  const path = tokenPath(ctiHome, appId, userOpenId);
  try { if (existsSync(path)) unlinkSync(path); } catch { /* best effort */ }
}

/** Find any stored token for this appId (any user). */
export function findAnyToken(ctiHome: string, appId: string): StoredUAToken | null {
  const dir = getOAuthDir(ctiHome);
  try {
    const { readdirSync } = require('fs');
    const files = readdirSync(dir) as string[];
    for (const f of files) {
      if (f.startsWith(`${appId}_`) && f.endsWith('.enc')) {
        const key = getMasterKey(ctiHome);
        const buf = readFileSync(join(dir, f));
        const json = decrypt(key, buf);
        return JSON.parse(json) as StoredUAToken;
      }
    }
  } catch { /* ignore */ }
  return null;
}
