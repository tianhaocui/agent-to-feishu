/**
 * CardKit streaming APIs for Feishu — thin wrapper around @larksuiteoapi/node-sdk.
 *
 * Provides typed, logged, error-classified wrappers for the CardKit v1 API.
 * Aligned with openclaw-lark's cardkit.ts module.
 *
 * All functions call `cardkit.v1.*` directly (no v2 shim needed).
 */

import type * as lark from '@larksuiteoapi/node-sdk';
import { CardKitApiError } from './feishu-card-error.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Feishu CardKit SDK response shape.
 * SDK TypeScript types don't include code/msg, but runtime returns them.
 */
interface CardKitResponse {
  code?: number;
  msg?: string;
  data?: Record<string, unknown>;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Log CardKit API response and throw on non-zero code. */
function checkResponse(resp: CardKitResponse, api: string, context: string): void {
  const { code, msg } = resp;
  if (code && code !== 0) {
    console.warn(`[feishu-cardkit] ${api} FAILED: code=${code} msg=${msg} ${context}`);
    throw new CardKitApiError({ api, code, msg: msg ?? '', context });
  }
}

// ---------------------------------------------------------------------------
// CardKit streaming APIs
// ---------------------------------------------------------------------------

/**
 * Create a card entity via the CardKit API.
 * Returns the card_id, or null on failure.
 */
export async function createCardEntity(
  client: lark.Client,
  card: Record<string, unknown>,
): Promise<string | null> {
  const response = (await client.cardkit.v1.card.create({
    data: {
      type: 'card_json',
      data: JSON.stringify(card),
    },
  })) as CardKitResponse;

  const cardId =
    ((response.data?.card_id ?? (response as Record<string, unknown>).card_id) as string | undefined) ?? null;
  checkResponse(response, 'card.create', `cardId=${cardId}`);
  return cardId;
}

/**
 * Stream text content to a specific card element.
 * The card diffs new content against previous and renders incrementally.
 */
export async function streamCardContent(
  client: lark.Client,
  cardId: string,
  elementId: string,
  content: string,
  sequence: number,
): Promise<void> {
  const resp = (await client.cardkit.v1.cardElement.content({
    data: { content, sequence },
    path: { card_id: cardId, element_id: elementId },
  })) as CardKitResponse;
  checkResponse(resp, 'cardElement.content', `seq=${sequence}, len=${content.length}`);
}

/**
 * Fully replace a card using the CardKit API.
 * Used for the final "complete" state update.
 */
export async function updateCardKitCard(
  client: lark.Client,
  cardId: string,
  card: Record<string, unknown>,
  sequence: number,
): Promise<void> {
  const resp = (await client.cardkit.v1.card.update({
    data: {
      card: { type: 'card_json', data: JSON.stringify(card) },
      sequence,
    },
    path: { card_id: cardId },
  })) as CardKitResponse;
  checkResponse(resp, 'card.update', `seq=${sequence}, cardId=${cardId}`);
}

/**
 * Close (or open) the streaming mode on a CardKit card.
 * Must be called after streaming to restore normal card behaviour.
 */
export async function setCardStreamingMode(
  client: lark.Client,
  cardId: string,
  streamingMode: boolean,
  sequence: number,
): Promise<void> {
  const resp = (await client.cardkit.v1.card.settings({
    data: {
      settings: JSON.stringify({ streaming_mode: streamingMode }),
      sequence,
    },
    path: { card_id: cardId },
  })) as CardKitResponse;
  checkResponse(resp, 'card.settings', `seq=${sequence}, streaming_mode=${streamingMode}`);
}

/**
 * Send an interactive card message by referencing a CardKit card_id.
 * Links the IM message to the CardKit card entity for streaming updates.
 */
export async function sendCardByCardId(
  client: lark.Client,
  params: {
    to: string;
    cardId: string;
    replyToMessageId?: string;
  },
): Promise<{ messageId: string }> {
  const contentPayload = JSON.stringify({
    type: 'card',
    data: { card_id: params.cardId },
  });

  if (params.replyToMessageId) {
    const response = await client.im.message.reply({
      path: { message_id: params.replyToMessageId },
      data: {
        content: contentPayload,
        msg_type: 'interactive',
      },
    });
    return { messageId: response?.data?.message_id ?? '' };
  }

  const response = await client.im.message.create({
    params: { receive_id_type: 'chat_id' },
    data: {
      receive_id: params.to,
      msg_type: 'interactive',
      content: contentPayload,
    },
  });
  return { messageId: response?.data?.message_id ?? '' };
}
