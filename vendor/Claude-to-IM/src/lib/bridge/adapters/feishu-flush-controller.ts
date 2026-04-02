/**
 * FlushController — mutex-guarded throttled flush for streaming card updates.
 *
 * A pure scheduling primitive that manages timer-based throttling,
 * mutex-guarded flushing, and reflush-on-conflict. Contains no
 * business logic — the actual flush work is provided via a callback.
 *
 * Aligned with openclaw-lark's FlushController pattern.
 */

/** Throttle constants (ms). */
export const THROTTLE_CONSTANTS = {
  /** CardKit streaming update interval. */
  CARDKIT_MS: 100,
  /** IM message.patch fallback interval. */
  PATCH_MS: 500,
  /** If gap since last update exceeds this, batch briefly before flushing. */
  LONG_GAP_THRESHOLD_MS: 2000,
  /** Delay after a long gap to batch initial content. */
  BATCH_AFTER_GAP_MS: 150,
} as const;

export class FlushController {
  private flushInProgress = false;
  private flushResolvers: Array<() => void> = [];
  private needsReflush = false;
  private pendingFlushTimer: ReturnType<typeof setTimeout> | null = null;
  private lastUpdateTime = 0;
  private isCompleted = false;
  private _cardMessageReady = false;

  constructor(private readonly doFlush: () => Promise<void>) {}

  /** Mark the controller as completed — no more flushes after current one. */
  complete(): void {
    this.isCompleted = true;
  }

  /** Cancel any pending deferred flush timer. */
  cancelPendingFlush(): void {
    if (this.pendingFlushTimer) {
      clearTimeout(this.pendingFlushTimer);
      this.pendingFlushTimer = null;
    }
  }

  /** Wait for any in-progress flush to finish. */
  waitForFlush(): Promise<void> {
    if (!this.flushInProgress) return Promise.resolve();
    return new Promise<void>((resolve) => this.flushResolvers.push(resolve));
  }

  /**
   * Execute a flush (mutex-guarded, with reflush on conflict).
   *
   * If a flush is already in progress, marks needsReflush so a
   * follow-up flush fires immediately after the current one completes.
   */
  async flush(): Promise<void> {
    if (!this._cardMessageReady || this.flushInProgress || this.isCompleted) {
      if (this.flushInProgress && !this.isCompleted) this.needsReflush = true;
      return;
    }
    this.flushInProgress = true;
    this.needsReflush = false;
    // Update timestamp BEFORE the API call to prevent concurrent callers
    // from also entering the flush (race condition fix).
    this.lastUpdateTime = Date.now();
    try {
      await this.doFlush();
      this.lastUpdateTime = Date.now();
    } finally {
      this.flushInProgress = false;
      const resolvers = this.flushResolvers;
      this.flushResolvers = [];
      for (const resolve of resolvers) resolve();

      // If events arrived while the API call was in flight,
      // schedule an immediate follow-up flush.
      if (this.needsReflush && !this.isCompleted && !this.pendingFlushTimer) {
        this.needsReflush = false;
        this.pendingFlushTimer = setTimeout(() => {
          this.pendingFlushTimer = null;
          void this.flush();
        }, 0);
      }
    }
  }

  /**
   * Throttled update entry point.
   *
   * @param throttleMs - Minimum interval between flushes.
   */
  async throttledUpdate(throttleMs: number): Promise<void> {
    if (!this._cardMessageReady) return;

    const now = Date.now();
    const elapsed = now - this.lastUpdateTime;

    if (elapsed >= throttleMs) {
      this.cancelPendingFlush();
      if (elapsed > THROTTLE_CONSTANTS.LONG_GAP_THRESHOLD_MS) {
        // After a long gap, batch briefly so the first visible update
        // contains meaningful text rather than just 1-2 characters.
        this.lastUpdateTime = now;
        this.pendingFlushTimer = setTimeout(() => {
          this.pendingFlushTimer = null;
          void this.flush();
        }, THROTTLE_CONSTANTS.BATCH_AFTER_GAP_MS);
      } else {
        await this.flush();
      }
    } else if (!this.pendingFlushTimer) {
      // Inside throttle window — schedule a deferred flush
      const delay = throttleMs - elapsed;
      this.pendingFlushTimer = setTimeout(() => {
        this.pendingFlushTimer = null;
        void this.flush();
      }, delay);
    }
  }

  /** Gate: card message must be ready before flushing. */
  cardMessageReady(): boolean {
    return this._cardMessageReady;
  }

  setCardMessageReady(ready: boolean): void {
    this._cardMessageReady = ready;
    if (ready) {
      this.lastUpdateTime = Date.now();
    }
  }
}
