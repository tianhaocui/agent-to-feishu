/**
 * UnavailableGuard — centralized guard for recalled/deleted messages.
 *
 * Wraps a streaming card session. Before each card operation, call
 * `shouldSkip()` to check if the message is known-unavailable. On API
 * errors, call `terminate(err)` to detect terminal codes and abort the
 * entire pipeline.
 *
 * Ported from openclaw-lark (MIT).
 */

import {
  isMessageUnavailable,
  checkAndMarkTerminal,
  isTerminalMessageCode,
} from './message-unavailable.js';
import { extractLarkApiCode } from './adapters/feishu-card-error.js';

export interface UnavailableGuardOptions {
  replyToMessageId?: string;
  getCardMessageId: () => string | null;
  onTerminate: (apiCode: number) => void;
}

export class UnavailableGuard {
  private _terminated = false;
  private readonly replyToMessageId: string | undefined;
  private readonly getCardMessageId: () => string | null;
  private readonly onTerminate: (apiCode: number) => void;

  constructor(opts: UnavailableGuardOptions) {
    this.replyToMessageId = opts.replyToMessageId;
    this.getCardMessageId = opts.getCardMessageId;
    this.onTerminate = opts.onTerminate;
  }

  get isTerminated(): boolean {
    return this._terminated;
  }

  /**
   * Check if the message is known-unavailable. If so, terminate and return true.
   */
  shouldSkip(): boolean {
    if (this._terminated) return true;
    if (this.replyToMessageId && isMessageUnavailable(this.replyToMessageId)) {
      this.doTerminate(230001);
      return true;
    }
    const cardMsgId = this.getCardMessageId();
    if (cardMsgId && isMessageUnavailable(cardMsgId)) {
      this.doTerminate(230001);
      return true;
    }
    return false;
  }

  /**
   * Check if an error is a terminal message error. If so, mark cache and terminate.
   * Returns true if terminated.
   */
  terminate(err?: unknown): boolean {
    if (this._terminated) return true;

    // Check replyToMessageId
    if (this.replyToMessageId) {
      const code = checkAndMarkTerminal(this.replyToMessageId, err);
      if (code !== undefined) { this.doTerminate(code); return true; }
    }

    // Check cardMessageId
    const cardMsgId = this.getCardMessageId();
    if (cardMsgId) {
      const code = checkAndMarkTerminal(cardMsgId, err);
      if (code !== undefined) { this.doTerminate(code); return true; }
    }

    // Fallback: check error code directly
    const code = extractLarkApiCode(err);
    if (isTerminalMessageCode(code)) {
      if (this.replyToMessageId) checkAndMarkTerminal(this.replyToMessageId, err);
      if (cardMsgId) checkAndMarkTerminal(cardMsgId, err);
      this.doTerminate(code!);
      return true;
    }

    return false;
  }

  private doTerminate(apiCode: number): void {
    if (this._terminated) return;
    this._terminated = true;
    console.log(`[unavailable-guard] Terminated: apiCode=${apiCode}, replyTo=${this.replyToMessageId}, card=${this.getCardMessageId()}`);
    try { this.onTerminate(apiCode); } catch { /* best effort */ }
  }
}
