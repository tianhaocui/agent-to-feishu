/**
 * ImageResolver — converts image URLs in markdown to Feishu image keys.
 *
 * Used by the streaming card pipeline to asynchronously download and upload
 * images referenced via `![alt](https://...)` in model-generated markdown,
 * replacing them with `![alt](img_xxx)` that Feishu cards can render.
 *
 * Ported from openclaw-lark (MIT).
 */

import type * as lark from '@larksuiteoapi/node-sdk';

/** Matches complete markdown image syntax: `![alt](value)` */
const IMAGE_RE = /!\[([^\]]*)\]\(([^)\s]+)\)/g;

/** Basic SSRF check — reject private/loopback IPs. */
function isPrivateUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return /^(127\.|10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|0\.|localhost|::1|\[::1\])/i.test(host);
  } catch { return true; }
}

export interface ImageResolverOptions {
  restClient: lark.Client;
  /** Called when a previously-pending image upload completes. */
  onImageResolved: () => void;
}

export class ImageResolver {
  private readonly resolved = new Map<string, string>();
  private readonly pending = new Map<string, Promise<string | null>>();
  private readonly failed = new Set<string>();

  private readonly restClient: lark.Client;
  private readonly onImageResolved: () => void;

  constructor(opts: ImageResolverOptions) {
    this.restClient = opts.restClient;
    this.onImageResolved = opts.onImageResolved;
  }

  /**
   * Synchronously resolve image URLs in markdown text.
   * - `img_xxx` references pass through.
   * - Cached URLs are replaced inline.
   * - Pending/new URLs are stripped and async upload is kicked off.
   */
  resolveImages(text: string): string {
    if (!text.includes('![')) return text;
    return text.replace(IMAGE_RE, (fullMatch, alt: string, value: string) => {
      if (value.startsWith('img_')) return fullMatch;
      if (!value.startsWith('http://') && !value.startsWith('https://')) return '';
      const cached = this.resolved.get(value);
      if (cached) return `![${alt}](${cached})`;
      if (this.failed.has(value)) return '';
      if (this.pending.has(value)) return '';
      this.startUpload(value);
      return '';
    });
  }

  /**
   * Trigger uploads for new URLs, wait for pending, then return resolved text.
   */
  async resolveImagesAwait(text: string, timeoutMs: number): Promise<string> {
    this.resolveImages(text);
    if (this.pending.size > 0) {
      console.log(`[image-resolver] Waiting for ${this.pending.size} upload(s), timeout=${timeoutMs}ms`);
      const allUploads = Promise.all(this.pending.values());
      const timeout = new Promise<void>((resolve) => setTimeout(resolve, timeoutMs));
      await Promise.race([allUploads, timeout]);
    }
    return this.resolveImages(text);
  }

  private startUpload(url: string): void {
    this.pending.set(url, this.doUpload(url));
  }

  private async doUpload(url: string): Promise<string | null> {
    try {
      if (isPrivateUrl(url)) {
        this.failed.add(url);
        return null;
      }
      console.log(`[image-resolver] Downloading: ${url}`);
      const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buffer = Buffer.from(await res.arrayBuffer());

      const uploadRes = await this.restClient.im.image.create({
        data: { image_type: 'message', image: buffer as any },
      });
      const imageKey = (uploadRes as any)?.data?.image_key;
      if (!imageKey) throw new Error('No image_key in response');

      console.log(`[image-resolver] Uploaded: ${url} -> ${imageKey}`);
      this.resolved.set(url, imageKey);
      this.pending.delete(url);
      this.onImageResolved();
      return imageKey;
    } catch (err) {
      console.warn(`[image-resolver] Upload failed: ${url}`, err instanceof Error ? err.message : err);
      this.pending.delete(url);
      this.failed.add(url);
      return null;
    }
  }
}