/**
 * Message unavailable detection and caching.
 *
 * When a user recalls or deletes a message while the bot is still responding,
 * Feishu API calls targeting that message return terminal error codes.
 * This module provides a TTL-based cache so subsequent operations on the same
 * message can skip immediately without hitting the API.
 *
 * Ported from openclaw-lark (MIT).
 */

import { extractLarkApiCode } from './adapters/feishu-card-error.js';

/** Terminal error codes indicating a message is permanently unavailable. */
const MESSAGE_TERMINAL_CODES = new Set([
  230001,  // MESSAGE_NOT_FOUND
  230011,  // MESSAGE_RECALLED
  230014,  // MESSAGE_RECALLED (alt)
  231003,  // MESSAGE_DELETED
]);

interface CacheEntry {
  apiCode: number;
  markedAt: number;
}

const TTL_MS = 30 * 60 * 1000; // 30 minutes
const MAX_ENTRIES = 512;
const cache = new Map<string, CacheEntry>();

function prune(): void {
  if (cache.size <= MAX_ENTRIES) return;
  const now = Date.now();
  for (const [key, entry] of cache) {
    if (now - entry.markedAt > TTL_MS) cache.delete(key);
  }
  // If still over limit, delete oldest
  while (cache.size > MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
    else break;
  }
}

export function markMessageUnavailable(messageId: string, apiCode: number): void {
  cache.set(messageId, { apiCode, markedAt: Date.now() });
  prune();
}

export function isMessageUnavailable(messageId: string): boolean {
  const entry = cache.get(messageId);
  if (!entry) return false;
  if (Date.now() - entry.markedAt > TTL_MS) {
    cache.delete(messageId);
    return false;
  }
  return true;
}

export function isTerminalMessageCode(code: number | undefined): boolean {
  return code !== undefined && MESSAGE_TERMINAL_CODES.has(code);
}

/** Custom error for unavailable messages. */
export class MessageUnavailableError extends Error {
  readonly messageId: string;
  readonly apiCode: number;

  constructor(messageId: string, apiCode: number) {
    super(`Message ${messageId} is unavailable (code=${apiCode})`);
    this.name = 'MessageUnavailableError';
    this.messageId = messageId;
    this.apiCode = apiCode;
  }
}

/**
 * Check if an error indicates a terminal message state, and if so mark it.
 * Returns the API code if terminal, undefined otherwise.
 */
export function checkAndMarkTerminal(messageId: string, err: unknown): number | undefined {
  const code = extractLarkApiCode(err);
  if (code !== undefined && MESSAGE_TERMINAL_CODES.has(code)) {
    markMessageUnavailable(messageId, code);
    return code;
  }
  return undefined;
}
