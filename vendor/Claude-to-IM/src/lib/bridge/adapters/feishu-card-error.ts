/**
 * CardKit API error classification for Feishu.
 *
 * Provides structured error types and classification functions for
 * CardKit streaming API errors, aligned with openclaw-lark patterns.
 */

/** Structured error for CardKit API failures. */
export class CardKitApiError extends Error {
  readonly api: string;
  readonly code: number;
  readonly msg: string;

  constructor(params: { api: string; code: number; msg: string; context?: string }) {
    super(`CardKit ${params.api} failed: code=${params.code} msg=${params.msg}${params.context ? ` (${params.context})` : ''}`);
    this.name = 'CardKitApiError';
    this.api = params.api;
    this.code = params.code;
    this.msg = params.msg;
  }
}

/** Extract Lark API error code from an error object. */
export function extractLarkApiCode(err: unknown): number | undefined {
  if (!err || typeof err !== 'object') return undefined;
  const e = err as Record<string, unknown>;
  // SDK errors: { code: number }
  if (typeof e.code === 'number') return e.code;
  // CardKitApiError
  if (err instanceof CardKitApiError) return err.code;
  // Nested response: { response: { data: { code } } }
  const resp = e.response as Record<string, unknown> | undefined;
  if (resp?.data && typeof resp.data === 'object') {
    const data = resp.data as Record<string, unknown>;
    if (typeof data.code === 'number') return data.code;
  }
  return undefined;
}

/** Rate limit error (code 230020) — skip this frame, don't degrade. */
export function isCardRateLimitError(err: unknown): boolean {
  return extractLarkApiCode(err) === 230020;
}

/**
 * Card table limit exceeded (code 230099 or 11310).
 * Disable CardKit streaming but keep originalCardId for final update.
 */
export function isCardTableLimitError(err: unknown): boolean {
  const code = extractLarkApiCode(err);
  return code === 230099 || code === 11310;
}

/** Feishu card table limit (max tables per card). */
export const FEISHU_CARD_TABLE_LIMIT = 25;

/**
 * Message unavailable error — message was recalled/deleted.
 * Codes: 230001 (message not found), 230014 (message recalled).
 */
export function isMessageUnavailableError(err: unknown): boolean {
  const code = extractLarkApiCode(err);
  return code === 230001 || code === 230014;
}

/**
 * Sanitize text segments for card rendering.
 * If total table count exceeds the limit, convert tables to code blocks.
 */
export function sanitizeTextSegmentsForCard(
  segments: string[],
  tableLimit: number = FEISHU_CARD_TABLE_LIMIT,
): string[] {
  // Count tables across all segments
  const tablePattern = /\|.+\|[\r\n]+\|[-:| ]+\|/g;
  let totalTables = 0;
  for (const seg of segments) {
    const matches = seg.match(tablePattern);
    if (matches) totalTables += matches.length;
  }

  if (totalTables <= tableLimit) return segments;

  // Degrade: wrap tables in code blocks
  return segments.map((seg) =>
    seg.replace(/(\|.+\|[\r\n]+\|[-:| ]+\|[\s\S]*?)(?=\n\n|\n[^|]|$)/g, '```\n$1\n```'),
  );
}
