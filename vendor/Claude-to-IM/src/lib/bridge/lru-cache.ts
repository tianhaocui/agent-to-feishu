/**
 * Generic TTL-aware LRU cache.
 *
 * - Entries expire after `ttlMs` milliseconds (checked on read).
 * - When the cache exceeds `maxSize`, the oldest entry is evicted on write.
 * - Backed by ES2015 Map (insertion-order = LRU order).
 */
export class LruCache<V> {
  private map = new Map<string, { value: V; expiresAt: number }>();

  constructor(
    private maxSize: number,
    private ttlMs: number,
  ) {}

  get(key: string): V | undefined {
    const entry = this.map.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      this.map.delete(key);
      return undefined;
    }
    // LRU refresh: delete + re-insert at tail
    this.map.delete(key);
    this.map.set(key, entry);
    return entry.value;
  }

  has(key: string): boolean {
    return this.get(key) !== undefined;
  }

  set(key: string, value: V): void {
    this.map.delete(key); // remove old position if exists
    this.map.set(key, { value, expiresAt: Date.now() + this.ttlMs });
    this.evict();
  }

  delete(key: string): void {
    this.map.delete(key);
  }

  clear(): void {
    this.map.clear();
  }

  get size(): number {
    return this.map.size;
  }

  /** Bulk get — returns a Map of found entries. */
  getMany(keys: string[]): Map<string, V> {
    const result = new Map<string, V>();
    for (const key of keys) {
      const val = this.get(key);
      if (val !== undefined) result.set(key, val);
    }
    return result;
  }

  /** Bulk set. */
  setMany(entries: Array<[string, V]>): void {
    for (const [key, value] of entries) {
      this.set(key, value);
    }
  }

  /** Return keys from the input that are NOT in the cache (or expired). */
  filterMissing(keys: string[]): string[] {
    return keys.filter(k => !this.has(k));
  }

  /** Iterate over all non-expired entries as [key, value] pairs. */
  *entries(): IterableIterator<[string, V]> {
    const now = Date.now();
    for (const [key, entry] of this.map) {
      if (now <= entry.expiresAt) {
        yield [key, entry.value];
      }
    }
  }

  private evict(): void {
    while (this.map.size > this.maxSize) {
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) this.map.delete(oldest);
      else break;
    }
  }
}
