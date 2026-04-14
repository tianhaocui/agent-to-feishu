/**
 * Feishu (Lark) Adapter — implements BaseChannelAdapter for Feishu Bot API.
 *
 * Uses the official @larksuiteoapi/node-sdk WSClient for real-time event
 * subscription and REST Client for message sending / resource downloading.
 *
 * Optimized to align with openclaw-lark (larksuite/openclaw-lark) patterns:
 * - CardKit v1 API directly (no v2 shim)
 * - FlushController for mutex-guarded streaming updates
 * - Explicit CardPhase state machine
 * - Error classification (rate limit, table limit, unavailable)
 * - Abort fast-path for immediate stream cancellation
 * - Enhanced reasoning/thinking display with collapsible panels
 */

import crypto from 'crypto';
import * as lark from '@larksuiteoapi/node-sdk';
import type {
  ChannelType,
  InboundMessage,
  OutboundMessage,
  SendResult,
  FileAttachment,
  ToolCallInfo,
} from '../types.js';
import { BaseChannelAdapter, registerAdapterFactory } from '../channel-adapter.js';
import { getBridgeContext } from '../context.js';
import {
  htmlToFeishuMarkdown,
  preprocessFeishuMarkdown,
  hasComplexMarkdown,
  buildCardContent,
  buildPostContent,
  buildStreamingContent,
  buildFinalCardJson,
  buildPermissionButtonCard,
  formatElapsed,
  optimizeMarkdownStyle,
  buildToolProgressMarkdown,
  splitReasoningText,
  stripReasoningTags,
} from '../markdown/feishu.js';
import {
  createCardEntity,
  streamCardContent,
  updateCardKitCard,
  setCardStreamingMode,
  sendCardByCardId,
} from './feishu-cardkit.js';
import { FlushController, THROTTLE_CONSTANTS } from './feishu-flush-controller.js';
import {
  isCardRateLimitError,
  isCardTableLimitError,
  isMessageUnavailableError,
  extractLarkApiCode,
} from './feishu-card-error.js';
import { LruCache } from '../lru-cache.js';

/** Max file download size (20 MB). */
const MAX_FILE_SIZE = 20 * 1024 * 1024;

/** Feishu emoji type for typing indicator. */
const TYPING_EMOJI = 'Typing';

/** Element ID for streaming content in CardKit cards. */
const STREAMING_ELEMENT_ID = 'streaming_content';

// ── Card Phase State Machine ─────────────────────────────────

type CardPhase = 'idle' | 'creating' | 'streaming' | 'completed' | 'aborted' | 'error' | 'creation_failed';

const TERMINAL_PHASES = new Set<CardPhase>(['completed', 'aborted', 'error', 'creation_failed']);

/** Valid phase transitions. */
const PHASE_TRANSITIONS: Record<CardPhase, Set<CardPhase>> = {
  idle: new Set(['creating']),
  creating: new Set(['streaming', 'creation_failed', 'aborted', 'error']),
  streaming: new Set(['completed', 'aborted', 'error']),
  completed: new Set(),
  aborted: new Set(),
  error: new Set(),
  creation_failed: new Set(),
};

/** State for an active streaming card. */
interface StreamingCardState {
  phase: CardPhase;
  cardId: string | null;
  /** Original cardId preserved when CardKit streaming is disabled mid-stream. */
  originalCardId: string | null;
  messageId: string | null;
  sequence: number;
  startTime: number;
  toolCalls: ToolCallInfo[];
  // Text accumulation
  accumulatedText: string;
  completedText: string;
  streamingPrefix: string;
  lastPartialText: string;
  // Reasoning state
  reasoningStartTime: number | null;
  reasoningElapsedMs: number;
  isReasoningPhase: boolean;
  accumulatedReasoningText: string;
  // Sub-controllers
  flush: FlushController;
  /** Periodic timer to refresh tool elapsed time display. */
  toolHeartbeat: ReturnType<typeof setInterval> | null;
  /** Whether the message was detected as unavailable (recalled/deleted). */
  terminated: boolean;
  /** Image resolver for converting markdown image URLs to Feishu image keys. */
  imageResolver: import('../card-image-resolver.js').ImageResolver | null;
  /** Centralized guard for recalled/deleted message detection. */
  guard: import('../unavailable-guard.js').UnavailableGuard | null;
}

/** Escape a string for use in a RegExp. */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Abort text patterns for fast-path detection. */
const ABORT_PATTERNS = /^(\/stop|stop|停止|取消|abort|cancel)$/i;

/** Shape of the SDK's im.message.receive_v1 event data. */
type FeishuMessageEventData = {
  sender: {
    sender_id?: {
      open_id?: string;
      union_id?: string;
      user_id?: string;
    };
    sender_type: string;
    tenant_key?: string;
  };
  message: {
    message_id: string;
    parent_id?: string;
    chat_id: string;
    chat_type: string;
    message_type: string;
    content: string;
    create_time: string;
    root_id?: string;
    thread_id?: string;
    mentions?: Array<{
      key: string;
      id: { open_id?: string; union_id?: string; user_id?: string };
      name: string;
    }>;
  };
};

/** MIME type guesses by message_type. */
const MIME_BY_TYPE: Record<string, string> = {
  image: 'image/png',
  file: 'application/octet-stream',
  audio: 'audio/ogg',
  video: 'video/mp4',
  media: 'application/octet-stream',
};

export class FeishuAdapter extends BaseChannelAdapter {
  readonly channelType: ChannelType = 'feishu';

  private running = false;
  private queue: InboundMessage[] = [];
  private waiters: Array<(msg: InboundMessage | null) => void> = [];
  private wsClient: lark.WSClient | null = null;
  private restClient: lark.Client | null = null;
  private seenMessageIds = new LruCache<true>(5000, 12 * 60 * 60 * 1000);
  private botOpenId: string | null = null;
  /** Bot's display name from /bot/v3/info/ API. */
  public botName: string | null = null;
  /** All known bot IDs (open_id, user_id, union_id) for mention matching. */
  private botIds = new Set<string>();
  /** Track last incoming message ID per chat for typing indicator. */
  private lastIncomingMessageId = new Map<string, string>();
  /** Track active typing reaction IDs per chat for cleanup. */
  private typingReactions = new Map<string, string>();
  /** Active streaming card state per chatId. */
  private activeCards = new Map<string, StreamingCardState>();
  /** In-flight card creation promises per chatId — prevents duplicate creation. */
  private cardCreatePromises = new Map<string, Promise<boolean>>();
  /** Known bots registry: name (lowercase) -> openId. */
  private knownBots = new Map<string, string>();
  /** Reverse lookup: openId -> name. */
  private knownBotsByOpenId = new Map<string, string>();
  /** Observed bots per group chat: chatId -> Set<botName>. */
  private groupObservedBots = new Map<string, Set<string>>();
  /** Track which chatIds are group chats (for relay filtering). */
  private groupChatIds = new Set<string>();
  /** LRU cache: openId -> display name (TTL 30min, max 500). */
  private userNameCache = new LruCache<string>(500, 30 * 60 * 1000);
  /** LRU cache: chatId -> chat info (TTL 1hr, max 500). */
  private chatInfoCache = new LruCache<{ name: string; chatMode?: string; groupMessageType?: string }>(500, 60 * 60 * 1000);

  // ── Lifecycle ───────────────────────────────────────────────

  async start(): Promise<void> {
    if (this.running) return;

    const configError = this.validateConfig();
    if (configError) {
      console.warn('[feishu-adapter] Cannot start:', configError);
      return;
    }

    const appId = getBridgeContext().store.getSetting('bridge_feishu_app_id') || '';
    const appSecret = getBridgeContext().store.getSetting('bridge_feishu_app_secret') || '';
    const domainSetting = getBridgeContext().store.getSetting('bridge_feishu_domain') || 'feishu';
    const domain = domainSetting === 'lark'
      ? lark.Domain.Lark
      : lark.Domain.Feishu;

    // Phase 2: Respect user's domain setting (no longer forced to Lark)
    this.restClient = new lark.Client({
      appId,
      appSecret,
      domain,
    });

    // Phase 1: No v2 shim needed — we call cardkit.v1 directly via feishu-cardkit.ts

    // Resolve bot identity for @mention detection
    await this.resolveBotIdentity(appId, appSecret, domain);

    // Load known bots from config for multi-bot collaboration
    this.loadKnownBots();

    this.running = true;

    // Create EventDispatcher and register event handlers.
    const dispatcher = new lark.EventDispatcher({}).register({
      'im.message.receive_v1': async (data) => {
        await this.handleIncomingEvent(data as FeishuMessageEventData);
      },
      'card.action.trigger': (async (data: unknown) => {
        return await this.handleCardAction(data);
      }) as any,
      'im.message.reaction.created_v1': (async (data: unknown) => {
        await this.handleReactionEvent(data);
      }) as any,
    });

    // Create and start WSClient
    this.wsClient = new lark.WSClient({
      appId,
      appSecret,
      domain,
    });

    // Monkey-patch WSClient.handleEventData to support card action events (type: "card").
    // The SDK's WSClient only processes type="event" messages. Card action callbacks
    // arrive as type="card" and would be silently dropped without this patch.
    // Still needed at SDK v1.60.0 — no public API for card actions via WSClient.
    const wsClientAny = this.wsClient as any;
    if (typeof wsClientAny.handleEventData === 'function') {
      const origHandleEventData = wsClientAny.handleEventData.bind(wsClientAny);
      wsClientAny.handleEventData = (data: any) => {
        const msgType = data.headers?.find?.((h: any) => h.key === 'type')?.value;
        if (msgType === 'card') {
          const patchedData = {
            ...data,
            headers: data.headers.map((h: any) =>
              h.key === 'type' ? { ...h, value: 'event' } : h,
            ),
          };
          return origHandleEventData(patchedData);
        }
        return origHandleEventData(data);
      };
    }

    this.wsClient.start({ eventDispatcher: dispatcher });

    console.log('[feishu-adapter] Started (botOpenId:', this.botOpenId || 'unknown', ')');

    // Warm up p2p channels — after a daemon restart, the Feishu WSClient may
    // not receive private-chat events until the p2p session is "touched" via
    // a REST API call.  Fire-and-forget a lightweight im.chat.get for each
    // known non-group binding so the platform re-associates the WS connection
    // with those p2p conversations.
    this.warmP2pChannels().catch(() => {});
    this.discoverPeerBotsFromGroups().catch(() => {});
  }

  /**
   * Touch known p2p chat bindings via REST API so the Feishu platform
   * resumes pushing private-chat events over the current WS connection.
   */
  private async warmP2pChannels(): Promise<void> {
    if (!this.restClient) return;
    try {
      const bindings = getBridgeContext().store.listChannelBindings('feishu');
      const p2pChats = bindings
        .filter(b => b.active && b.chatId && !b.chatId.startsWith('oc_'))
        .map(b => b.chatId);
      // Group chats always start with "oc_"; anything else is a p2p chat.
      // However, Feishu p2p chats also use the "oc_" prefix, so fall back to
      // warming ALL known bindings — the cost is one lightweight GET per chat.
      const allChats = bindings.filter(b => b.active && b.chatId).map(b => b.chatId);
      const targets = p2pChats.length > 0 ? p2pChats : allChats;
      if (targets.length === 0) return;

      console.log(`[feishu-adapter] Warming ${targets.length} chat channel(s)...`);
      for (const chatId of targets) {
        try {
          await this.restClient.im.chat.get({ path: { chat_id: chatId } });
        } catch {
          // Non-critical — the chat may have been deleted or bot removed
        }
      }
      console.log(`[feishu-adapter] Warm-up complete (${targets.length} chats)`);
    } catch (err) {
      console.warn('[feishu-adapter] p2p warm-up failed:', err instanceof Error ? err.message : err);
    }
  }

  /**
   * Discover peer bots by scanning group member lists at startup.
   * This ensures we know other bots' open_ids even if we never receive
   * messages mentioning them (e.g. when the app only gets @-mentioned msgs).
   */
  private async discoverPeerBotsFromGroups(): Promise<void> {
    // Wait for relay server to start (it starts after adapter)
    await new Promise(resolve => setTimeout(resolve, 3000));

    try {
      const { getRelayPeerNames, relayToBot } = await import('../bridge-manager.js');

      const myIdentity = JSON.stringify({
        type: 'identity',
        name: this.botName,
        openId: this.botOpenId,
      });

      // Retry up to 5 times with 3s intervals — peer bot may not be up yet
      for (let attempt = 0; attempt < 5; attempt++) {
        const peerNames = getRelayPeerNames();
        if (peerNames.length === 0 || !this.botOpenId || !this.botName) return;

        let allSent = true;
        for (const peerName of peerNames) {
          if (this.knownBots.has(peerName.toLowerCase())) continue; // already known
          try {
            const sent = await relayToBot(peerName, '__identity__', myIdentity, this.botName || 'unknown');
            if (sent) {
              console.log(`[feishu-adapter] Sent identity to peer: ${peerName}`);
            } else {
              allSent = false;
            }
          } catch {
            allSent = false;
          }
        }
        if (allSent) break;
        await new Promise(resolve => setTimeout(resolve, 3000));
      }
    } catch (err) {
      console.warn('[feishu-adapter] Peer identity exchange failed:', err instanceof Error ? err.message : err);
    }
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;

    if (this.wsClient) {
      try {
        this.wsClient.close({ force: true });
      } catch (err) {
        console.warn('[feishu-adapter] WSClient close error:', err instanceof Error ? err.message : err);
      }
      this.wsClient = null;
    }
    this.restClient = null;

    for (const waiter of this.waiters) {
      waiter(null);
    }
    this.waiters = [];

    // Clean up active cards
    for (const [, state] of this.activeCards) {
      if (state.toolHeartbeat) { clearInterval(state.toolHeartbeat); state.toolHeartbeat = null; }
      state.flush.cancelPendingFlush();
      state.flush.complete();
    }
    this.activeCards.clear();
    this.cardCreatePromises.clear();

    this.seenMessageIds.clear();
    this.lastIncomingMessageId.clear();
    this.typingReactions.clear();

    console.log('[feishu-adapter] Stopped');
  }

  isRunning(): boolean {
    return this.running;
  }

  // ── Queue ───────────────────────────────────────────────────

  consumeOne(): Promise<InboundMessage | null> {
    const queued = this.queue.shift();
    if (queued) return Promise.resolve(queued);

    if (!this.running) return Promise.resolve(null);

    return new Promise<InboundMessage | null>((resolve) => {
      this.waiters.push(resolve);
    });
  }

  private enqueue(msg: InboundMessage): void {
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter(msg);
    } else {
      this.queue.push(msg);
    }
  }

  /** Inject a message into the adapter queue (used by relay server). */
  public injectMessage(msg: InboundMessage): void {
    // If the relay message carries a real Feishu message ID, update
    // lastIncomingMessageId so the streaming card replies to it.
    if (msg.messageId && !msg.messageId.startsWith('relay-')) {
      this.lastIncomingMessageId.set(msg.address.chatId, msg.messageId);
    }
    this.enqueue(msg);
  }

  /** Register a peer bot's identity (called via relay identity exchange). */
  public registerPeerBot(name: string, openId: string): void {
    if (!name || !openId || this.botIds.has(openId)) return;
    if (!this.knownBots.has(name.toLowerCase())) {
      this.knownBots.set(name.toLowerCase(), openId);
      this.knownBotsByOpenId.set(openId, name);
      console.log(`[feishu-adapter] Registered peer bot via relay: ${name} -> ${openId}`);
    }
  }

  // ── Typing indicator (Openclaw-style reaction) ─────────────

  /**
   * Add a "Typing" emoji reaction to the user's message and create streaming card.
   * Called by bridge-manager via onMessageStart().
   */
  onMessageStart(chatId: string): void {
    const messageId = this.lastIncomingMessageId.get(chatId);

    // Create streaming card (fire-and-forget — fallback to traditional if fails)
    if (messageId) {
      this.createStreamingCard(chatId, messageId).catch(() => {});
    }

    // Typing indicator (same as before)
    if (!messageId || !this.restClient) return;
    this.restClient.im.messageReaction.create({
      path: { message_id: messageId },
      data: { reaction_type: { emoji_type: TYPING_EMOJI } },
    }).then((res) => {
      const reactionId = (res as any)?.data?.reaction_id;
      if (reactionId) {
        this.typingReactions.set(chatId, reactionId);
      }
    }).catch((err) => {
      const code = (err as { code?: number })?.code;
      if (code !== 99991400 && code !== 99991403) {
        console.warn('[feishu-adapter] Typing indicator failed:', err instanceof Error ? err.message : err);
      }
    });
  }

  async editMessage(messageId: string, text: string): Promise<boolean> {
    if (!this.restClient) return false;
    try {
      // Feishu only supports patching card messages, so delete and ignore errors
      await this.restClient.im.message.delete({
        path: { message_id: messageId },
      });
      return true;
    } catch (err) {
      console.warn('[feishu-adapter] editMessage (delete) failed:', err instanceof Error ? err.message : err);
      return false;
    }
  }

  /**
   * Remove the "Typing" emoji reaction and clean up card state.
   * Called by bridge-manager via onMessageEnd().
   */
  onMessageEnd(chatId: string): void {
    // Clean up any orphaned card state (normally cleaned by finalizeCard)
    this.cleanupCard(chatId);

    // Remove typing reaction (same as before)
    const reactionId = this.typingReactions.get(chatId);
    const messageId = this.lastIncomingMessageId.get(chatId);
    if (!reactionId || !messageId || !this.restClient) return;
    this.typingReactions.delete(chatId);
    this.restClient.im.messageReaction.delete({
      path: { message_id: messageId, reaction_id: reactionId },
    }).catch(() => { /* ignore */ });
  }

  // ── Card Action Handler ─────────────────────────────────────

  /**
   * Handle card.action.trigger events (button clicks on permission cards).
   * Converts button clicks to synthetic InboundMessage with callbackData.
   * Must return within 3 seconds (Feishu timeout), so uses a 2.5s race.
   */
  private async handleCardAction(data: unknown): Promise<unknown> {
    const FALLBACK_TOAST = { toast: { type: 'info' as const, content: '已收到' } };

    try {
      const event = data as any;
      const action = event?.action ?? {};
      const value = action?.value ?? {};
      const formValue = action?.form_value as Record<string, unknown> | undefined;
      const actionName = action?.name as string | undefined;

      // Extract chat/user context
      const chatId = event?.context?.open_chat_id || value.chatId || '';
      const messageId = event?.context?.open_message_id || event?.open_message_id || '';
      const userId = event?.operator?.open_id || event?.open_id || '';

      if (!chatId) return FALLBACK_TOAST;

      // Form submission (AskUserQuestion): extract questionId from button name
      if (formValue && actionName?.startsWith('ask_submit_')) {
        const questionId = actionName.slice('ask_submit_'.length);
        const callbackMsg: import('../types.js').InboundMessage = {
          messageId: messageId || `card_action_${Date.now()}`,
          address: { channelType: 'feishu', chatId, userId },
          text: '',
          timestamp: Date.now(),
          callbackData: `ask:submit:${questionId}`,
          callbackMessageId: messageId,
          formValue,
        };
        this.enqueue(callbackMsg);
        return { toast: { type: 'success' as const, content: '已提交' } };
      }

      // Regular button callback (permissions etc.)
      const callbackData = value.callback_data;
      if (!callbackData) return FALLBACK_TOAST;

      const callbackMsg: import('../types.js').InboundMessage = {
        messageId: messageId || `card_action_${Date.now()}`,
        address: { channelType: 'feishu', chatId, userId },
        text: '',
        timestamp: Date.now(),
        callbackData,
        callbackMessageId: messageId,
      };
      this.enqueue(callbackMsg);

      return { toast: { type: 'info' as const, content: '已收到，正在处理...' } };
    } catch (err) {
      console.error('[feishu-adapter] Card action handler error:', err instanceof Error ? err.message : err);
      return FALLBACK_TOAST;
    }
  }

  // ── Reaction Event Handler ────────────────────────────────

  private async handleReactionEvent(data: unknown): Promise<void> {
    const reactionMode = getBridgeContext().store.getSetting('bridge_feishu_reaction_mode') || 'off';
    if (reactionMode === 'off') return;

    try {
      // Normalize event shape — SDK may or may not unwrap the envelope
      const raw = data as any;
      const ev = raw?.event ?? raw;
      const messageId = ev?.message_id;
      const reactorOpenId = ev?.user_id?.open_id;
      const emojiType = ev?.reaction_type?.emoji_type;
      const actionTime = ev?.action_time;
      if (!messageId || !reactorOpenId || !emojiType) return;

      if (this.botIds.has(reactorOpenId)) return;
      if (emojiType === TYPING_EMOJI) return;

      if (actionTime && this.isTimestampExpired(actionTime)) return;

      // Dedup
      const dedupKey = `reaction:${messageId}:${emojiType}:${reactorOpenId}`;
      if (this.seenMessageIds.has(dedupKey)) return;
      this.seenMessageIds.set(dedupKey, true);

      // Fetch original message to get context
      if (!this.restClient) return;
      const res = await this.restClient.im.message.get({
        path: { message_id: messageId },
      });
      const item = (res as any)?.data?.items?.[0];
      if (!item) return;

      const chatId = item.chat_id;
      const isGroup = (item.chat_type || 'p2p') === 'group';

      // 'own' mode: only react to reactions on bot's own messages
      if (reactionMode === 'own') {
        if (!(item.sender?.sender_type === 'app' && this.botIds.has(item.sender?.id || ''))) return;
      }

      const reactorName = this.userNameCache.get(reactorOpenId)
        || await this.resolveUserName(reactorOpenId)
        || reactorOpenId;

      const excerpt = this.extractPlainText(item).slice(0, 100);
      const syntheticText = `[${reactorName} reacted with ${emojiType} to: "${excerpt}"]`;

      this.enqueue({
        messageId: `reaction-${messageId}-${Date.now()}`,
        address: { channelType: 'feishu', chatId, userId: reactorOpenId },
        text: syntheticText,
        timestamp: Date.now(),
        senderType: 'user',
        senderName: reactorName,
        isGroup,
      });
    } catch (err) {
      console.warn('[feishu-adapter] Reaction event handler error:', err instanceof Error ? err.message : err);
    }
  }

  // ── Streaming Card (CardKit v1 — aligned with openclaw-lark) ────

  /** Phase transition with validation. */
  private transitionCard(state: StreamingCardState, to: CardPhase, source: string): boolean {
    const from = state.phase;
    if (from === to) return false;
    if (!PHASE_TRANSITIONS[from].has(to)) {
      console.warn(`[feishu-adapter] Phase transition rejected: ${from} → ${to} (source: ${source})`);
      return false;
    }
    state.phase = to;
    if (TERMINAL_PHASES.has(to)) {
      state.flush.cancelPendingFlush();
      state.flush.complete();
    }
    return true;
  }

  /**
   * Create a new streaming card and send it as a message.
   * Returns true if card was created successfully.
   */
  private createStreamingCard(chatId: string, replyToMessageId?: string): Promise<boolean> {
    if (!this.restClient || this.activeCards.has(chatId)) return Promise.resolve(false);

    const existing = this.cardCreatePromises.get(chatId);
    if (existing) return existing;

    const promise = this._doCreateStreamingCard(chatId, replyToMessageId);
    this.cardCreatePromises.set(chatId, promise);
    promise.finally(() => this.cardCreatePromises.delete(chatId));
    return promise;
  }

  private async _doCreateStreamingCard(chatId: string, replyToMessageId?: string): Promise<boolean> {
    if (!this.restClient) return false;

    // Initialize state with FlushController
    const state: StreamingCardState = {
      phase: 'idle',
      cardId: null,
      originalCardId: null,
      messageId: null,
      sequence: 0,
      startTime: Date.now(),
      toolCalls: [],
      accumulatedText: '',
      completedText: '',
      streamingPrefix: '',
      lastPartialText: '',
      reasoningStartTime: null,
      reasoningElapsedMs: 0,
      isReasoningPhase: false,
      accumulatedReasoningText: '',
      flush: null as any, // set below
      toolHeartbeat: null,
      terminated: false,
      imageResolver: null,
      guard: null,
    };

    // Create FlushController with performFlush bound to this state
    state.flush = new FlushController(() => this.performFlush(chatId));

    // Create ImageResolver for this card session
    if (this.restClient) {
      const { ImageResolver } = await import('../card-image-resolver.js');
      state.imageResolver = new ImageResolver({
        restClient: this.restClient,
        onImageResolved: () => { void state.flush.throttledUpdate(THROTTLE_CONSTANTS.CARDKIT_MS); },
      });
    }

    // Create UnavailableGuard for this card session
    {
      const { UnavailableGuard } = await import('../unavailable-guard.js');
      state.guard = new UnavailableGuard({
        replyToMessageId,
        getCardMessageId: () => state.messageId,
        onTerminate: () => {
          state.terminated = true;
          if (state.toolHeartbeat) { clearInterval(state.toolHeartbeat); state.toolHeartbeat = null; }
          state.flush.cancelPendingFlush();
          this.transitionCard(state, 'error', 'guard.terminated');
        },
      });
    }

    this.activeCards.set(chatId, state);

    if (!this.transitionCard(state, 'creating', 'createStreamingCard')) {
      this.activeCards.delete(chatId);
      return false;
    }

    try {
      // Step 1: Create card via CardKit v1
      const cardBody = {
        schema: '2.0',
        config: {
          streaming_mode: true,
          wide_screen_mode: true,
          locales: ['zh_cn', 'en_us'],
          summary: {
            content: 'Thinking...',
            i18n_content: { zh_cn: '思考中...', en_us: 'Thinking...' },
          },
        },
        body: {
          elements: [{
            tag: 'markdown',
            content: '',
            text_align: 'left',
            text_size: 'normal_v2',
            element_id: STREAMING_ELEMENT_ID,
          }],
        },
      };

      const cardId = await createCardEntity(this.restClient, cardBody);
      if (!cardId) {
        this.transitionCard(state, 'creation_failed', 'createStreamingCard.noCardId');
        this.activeCards.delete(chatId);
        return false;
      }

      state.cardId = cardId;
      state.originalCardId = cardId;
      state.sequence = 1;

      // Step 2: Send card as IM message
      const result = await sendCardByCardId(this.restClient, {
        to: chatId,
        cardId,
        replyToMessageId,
      });

      if (!result.messageId) {
        this.transitionCard(state, 'creation_failed', 'createStreamingCard.noMsgId');
        this.activeCards.delete(chatId);
        return false;
      }

      state.messageId = result.messageId;
      state.flush.setCardMessageReady(true);

      if (!this.transitionCard(state, 'streaming', 'createStreamingCard.success')) {
        this.activeCards.delete(chatId);
        return false;
      }

      return true;
    } catch (err) {
      if (state.guard?.terminate(err)) {
        // Guard handles cleanup
      } else if (isMessageUnavailableError(err)) {
        state.terminated = true;
      }
      console.warn('[feishu-adapter] Failed to create streaming card:', err instanceof Error ? err.message : err);
      this.transitionCard(state, 'creation_failed', 'createStreamingCard.error');
      this.activeCards.delete(chatId);
      return false;
    }
  }

  /**
   * Perform a single flush of card content to the Feishu API.
   * Called by FlushController — mutex-guarded.
   */
  private async performFlush(chatId: string): Promise<void> {
    const state = this.activeCards.get(chatId);
    if (!state || !this.restClient || !state.messageId || TERMINAL_PHASES.has(state.phase)) return;
    if (state.guard?.shouldSkip()) return;

    try {
      let displayText = this.buildDisplayText(state);
      // Resolve image URLs to Feishu image keys (async uploads happen in background)
      if (state.imageResolver) {
        displayText = state.imageResolver.resolveImages(displayText);
      }
      const resolvedText = optimizeMarkdownStyle(displayText);

      if (state.cardId) {
        // CardKit streaming — typewriter effect
        state.sequence++;
        await streamCardContent(
          this.restClient,
          state.cardId,
          STREAMING_ELEMENT_ID,
          resolvedText,
          state.sequence,
        );
      } else if (state.originalCardId) {
        // Fallback: CardKit streaming was disabled (e.g. timeout/table limit),
        // use full card update via originalCardId to keep progress visible.
        state.sequence++;
        const fallbackCard = {
          schema: '2.0',
          config: { wide_screen_mode: true },
          body: {
            elements: [{
              tag: 'markdown',
              content: resolvedText,
              text_align: 'left',
              text_size: 'normal_v2',
              element_id: STREAMING_ELEMENT_ID,
            }],
          },
        };
        await updateCardKitCard(this.restClient, state.originalCardId, fallbackCard, state.sequence);
      }
    } catch (err: unknown) {
      if (state.guard?.terminate(err)) return;
      if (isMessageUnavailableError(err)) {
        state.terminated = true;
        this.transitionCard(state, 'error', 'performFlush.unavailable');
        return;
      }

      // Rate limit (230020) — skip this frame, don't degrade
      if (isCardRateLimitError(err)) return;

      // Table limit (230099/11310) — disable CardKit streaming,
      // keep originalCardId for final update
      if (isCardTableLimitError(err)) {
        console.warn('[feishu-adapter] Card table limit exceeded, disabling CardKit streaming');
        state.cardId = null;
        return;
      }

      const code = extractLarkApiCode(err);
      console.warn(`[feishu-adapter] Card stream update failed: code=${code}`, err instanceof Error ? err.message : err);
      if (state.cardId) {
        state.cardId = null; // Disable CardKit streaming
      }
    }
  }

  /** Build display text from state for streaming updates, including tool progress. */
  private buildDisplayText(state: StreamingCardState): string {
    let content: string;
    if (state.isReasoningPhase && state.accumulatedReasoningText) {
      const reasoningDisplay = `💭 **Thinking...**\n\n${state.accumulatedReasoningText}`;
      content = state.accumulatedText
        ? state.accumulatedText + '\n\n' + reasoningDisplay
        : reasoningDisplay;
    } else {
      content = state.accumulatedText || '💭 Thinking...';
    }

    // Append tool progress with elapsed time
    const toolMd = buildToolProgressMarkdown(state.toolCalls);
    if (toolMd) {
      content = content + '\n\n' + toolMd;
    }
    return content;
  }

  /**
   * Update streaming card content with throttled flushing.
   */
  private updateCardContent(chatId: string, text: string): void {
    const state = this.activeCards.get(chatId);
    if (!state || !this.restClient || TERMINAL_PHASES.has(state.phase) || state.terminated) return;
    if (state.guard?.shouldSkip()) return;
    const split = splitReasoningText(text);
    if (split.reasoningText && !split.answerText) {
      // Pure reasoning payload — show thinking content in real-time
      if (!state.reasoningStartTime) state.reasoningStartTime = Date.now();
      state.isReasoningPhase = true;
      state.accumulatedReasoningText = split.reasoningText;
      void state.flush.throttledUpdate(
        state.cardId ? THROTTLE_CONSTANTS.CARDKIT_MS : THROTTLE_CONSTANTS.PATCH_MS,
      );
      return;
    }

    // Answer payload
    if (state.isReasoningPhase) {
      state.isReasoningPhase = false;
      state.reasoningElapsedMs = state.reasoningStartTime
        ? Date.now() - state.reasoningStartTime
        : 0;
    }
    if (split.reasoningText) {
      state.accumulatedReasoningText = split.reasoningText;
    }

    const answerText = split.answerText ?? stripReasoningTags(text);

    // Detect reply boundary: text length shrinks → new reply starts
    if (state.lastPartialText && answerText.length < state.lastPartialText.length) {
      state.streamingPrefix += (state.streamingPrefix ? '\n\n' : '') + state.lastPartialText;
    }
    state.lastPartialText = answerText;
    state.accumulatedText = state.streamingPrefix
      ? state.streamingPrefix + '\n\n' + answerText
      : answerText;

    void state.flush.throttledUpdate(
      state.cardId ? THROTTLE_CONSTANTS.CARDKIT_MS : THROTTLE_CONSTANTS.PATCH_MS,
    );
  }

  /**
   * Update tool progress in the streaming card.
   */
  private updateToolProgress(chatId: string, tools: ToolCallInfo[]): void {
    const state = this.activeCards.get(chatId);
    if (!state) return;
    state.toolCalls = tools;

    const hasRunning = tools.some(tc => tc.status === 'running');
    if (hasRunning && !state.toolHeartbeat) {
      // Start periodic flush to keep elapsed time updated (every 1s)
      state.toolHeartbeat = setInterval(() => {
        if (TERMINAL_PHASES.has(state.phase) || state.terminated || state.guard?.isTerminated) {
          if (state.toolHeartbeat) { clearInterval(state.toolHeartbeat); state.toolHeartbeat = null; }
          return;
        }
        void state.flush.throttledUpdate(
          state.cardId ? THROTTLE_CONSTANTS.CARDKIT_MS : THROTTLE_CONSTANTS.PATCH_MS,
        );
      }, 1_000);
    } else if (!hasRunning && state.toolHeartbeat) {
      clearInterval(state.toolHeartbeat);
      state.toolHeartbeat = null;
    }

    void state.flush.throttledUpdate(
      state.cardId ? THROTTLE_CONSTANTS.CARDKIT_MS : THROTTLE_CONSTANTS.PATCH_MS,
    );
  }

  /**
   * Finalize the streaming card: close streaming mode, update with final content + footer.
   */
  private async finalizeCard(
    chatId: string,
    status: 'completed' | 'interrupted' | 'error',
    responseText: string,
    meta?: import('../channel-adapter.js').StreamEndMeta,
  ): Promise<boolean> {
    const pending = this.cardCreatePromises.get(chatId);
    if (pending) {
      try { await pending; } catch { /* creation failed */ }
    }

    const state = this.activeCards.get(chatId);
    if (!state || !this.restClient) return false;
    if (TERMINAL_PHASES.has(state.phase) || state.terminated || state.guard?.shouldSkip()) {
      this.activeCards.delete(chatId);
      return false;
    }

    this.transitionCard(state, 'completed', `finalizeCard.${status}`);

    // Wait for any in-flight flush
    await state.flush.waitForFlush();

    const effectiveCardId = state.cardId ?? state.originalCardId;

    try {
      if (effectiveCardId && state.messageId) {
        // Step 1: Close streaming mode
        state.sequence++;
        await setCardStreamingMode(this.restClient, effectiveCardId, false, state.sequence);

        // Step 2: Build and apply final card
        const elapsedMs = Date.now() - state.startTime;
        let finalText = responseText || state.completedText || state.accumulatedText || '';
        // Wait for pending image uploads before final render
        if (state.imageResolver) {
          finalText = await state.imageResolver.resolveImagesAwait(finalText, 10_000);
        }
        const displayText = this.resolveOutboundMentions(finalText, 'card');

        const finalCardJson = buildFinalCardJson(displayText, state.toolCalls, {
          status,
          elapsed: formatElapsed(elapsedMs),
          reasoningText: state.accumulatedReasoningText || undefined,
          reasoningElapsedMs: state.reasoningElapsedMs || undefined,
          tokenUsage: meta?.tokenUsage || undefined,
          model: meta?.model || undefined,
        });

        state.sequence++;
        await updateCardKitCard(
          this.restClient,
          effectiveCardId,
          JSON.parse(finalCardJson),
          state.sequence,
        );

        return true;
      }
      return false;
    } catch (err) {
      console.warn('[feishu-adapter] Card finalize failed:', err instanceof Error ? err.message : err);
      return false;
    } finally {
      if (state.toolHeartbeat) { clearInterval(state.toolHeartbeat); state.toolHeartbeat = null; }
      this.activeCards.delete(chatId);
    }
  }

  /**
   * Clean up card state without finalizing.
   */
  private cleanupCard(chatId: string): void {
    this.cardCreatePromises.delete(chatId);
    const state = this.activeCards.get(chatId);
    if (!state) return;
    if (state.toolHeartbeat) { clearInterval(state.toolHeartbeat); state.toolHeartbeat = null; }
    state.flush.cancelPendingFlush();
    state.flush.complete();
    this.activeCards.delete(chatId);
  }

  /**
   * Check if there is an active streaming card for a given chat.
   */
  hasActiveCard(chatId: string): boolean {
    return this.activeCards.has(chatId);
  }

  // ── Streaming adapter interface ────────────────────────────────

  /**
   * Called by bridge-manager on each text SSE event.
   * Creates streaming card on first call, then updates content.
   */
  onStreamText(chatId: string, fullText: string): void {
    if (!this.activeCards.has(chatId)) {
      // Card should have been created by onMessageStart, but create lazily if not
      const messageId = this.lastIncomingMessageId.get(chatId);
      this.createStreamingCard(chatId, messageId).then((ok) => {
        if (ok) this.updateCardContent(chatId, fullText);
      }).catch(() => {});
      return;
    }
    this.updateCardContent(chatId, fullText);
  }

  onToolEvent(chatId: string, tools: ToolCallInfo[]): void {
    this.updateToolProgress(chatId, tools);
  }

  async onStreamEnd(chatId: string, status: 'completed' | 'interrupted' | 'error', responseText: string, meta?: import('../channel-adapter.js').StreamEndMeta): Promise<boolean> {
    // Capture the card's Feishu message ID before finalizeCard cleans up activeCards
    const cardMessageId = this.activeCards.get(chatId)?.messageId || undefined;
    const result = await this.finalizeCard(chatId, status, responseText, meta);

    // Multi-bot: relay mentions to peer bots via HTTP (group chats only)
    // Match both @[BotName] and @BotName (for known bots)
    const multiBotEnabled = getBridgeContext().store.getSetting('bridge_feishu_multi_bot_enabled') === 'true';
    if (multiBotEnabled && status === 'completed' && responseText && this.groupChatIds.has(chatId)) {
      const { relayToBot, getRelayPeerNames } = await import('../bridge-manager.js');
      const relayedBots = new Set<string>();

      // 1. @[BotName] format
      const bracketPattern = /@\[([^\]]+)\]/g;
      let match;
      while ((match = bracketPattern.exec(responseText)) !== null) {
        relayedBots.add(match[1]);
      }
      // 2. @BotName format — match against known bot names and relay peers
      const checkNames = new Set([...this.knownBots.keys(), ...getRelayPeerNames()]);
      for (const name of checkNames) {
        if (relayedBots.has(name)) continue;
        const pattern = new RegExp(`@${escapeRegex(name)}(?![\\w])`, 'gi');
        if (pattern.test(responseText)) {
          relayedBots.add(name);
        }
      }

      const myName = this.knownBotsByOpenId.get(this.botOpenId || '') || 'unknown';

      for (const botName of relayedBots) {
        try {
          const sent = await relayToBot(botName, chatId, responseText, myName, cardMessageId);
          if (sent) {
            console.log(`[feishu-adapter] Relayed to ${botName} via HTTP (replyMessageId=${cardMessageId})`);
          } else {
            console.warn(`[feishu-adapter] HTTP relay failed for ${botName}`);
          }
        } catch (err) {
          console.warn(`[feishu-adapter] Relay error for ${botName}:`, err);
        }
      }
    }

    return result;
  }

  // ── Send ────────────────────────────────────────────────────

  async send(message: OutboundMessage): Promise<SendResult> {
    if (!this.restClient) {
      return { ok: false, error: 'Feishu client not initialized' };
    }

    let text = message.text;

    // Convert HTML to markdown for Feishu rendering (e.g. command responses)
    if (message.parseMode === 'HTML') {
      text = htmlToFeishuMarkdown(text);
    }

    // Preprocess markdown for Claude responses
    if (message.parseMode === 'Markdown') {
      text = preprocessFeishuMarkdown(text);
    }

    // If there are inline buttons (permission prompts), send card with action buttons
    if (message.inlineButtons && message.inlineButtons.length > 0) {
      return this.sendPermissionCard(message.address.chatId, text, message.inlineButtons);
    }

    // Raw CardKit JSON (AskUserQuestion forms etc.)
    if (message.cardJson) {
      return this.sendRawCard(message.address.chatId, message.cardJson, message.replyToMessageId);
    }

    // Rendering strategy
    // - Code blocks / tables → interactive card (schema 2.0 markdown)
    // - Other text → post (md tag)
    if (hasComplexMarkdown(text)) {
      return this.sendAsCard(message.address.chatId, text);
    }
    return this.sendAsPost(message.address.chatId, text);
  }

  /**
   * Send text as an interactive card (schema 2.0 markdown).
   * Used for code blocks and tables — card renders them properly.
   */
  private async sendAsCard(chatId: string, text: string): Promise<SendResult> {
    const cardContent = buildCardContent(this.resolveOutboundMentions(text, 'card'));

    try {
      const res = await this.restClient!.im.message.create({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: chatId,
          msg_type: 'interactive',
          content: cardContent,
        },
      });

      if (res?.data?.message_id) {
        return { ok: true, messageId: res.data.message_id };
      }
      console.warn('[feishu-adapter] Card send failed:', res?.msg, res?.code);
    } catch (err) {
      console.warn('[feishu-adapter] Card send error, falling back to post:', err instanceof Error ? err.message : err);
    }

    // Fallback to post
    return this.sendAsPost(chatId, text);
  }

  /**
   * Send text as a post message (msg_type: 'post') with md tag.
   * Used for simple text — renders bold, italic, inline code, links.
   */
  private async sendAsPost(chatId: string, text: string): Promise<SendResult> {
    const postContent = buildPostContent(this.resolveOutboundMentions(text, 'post'));

    try {
      const res = await this.restClient!.im.message.create({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: chatId,
          msg_type: 'post',
          content: postContent,
        },
      });

      if (res?.data?.message_id) {
        return { ok: true, messageId: res.data.message_id };
      }
      console.warn('[feishu-adapter] Post send failed:', res?.msg, res?.code);
    } catch (err) {
      console.warn('[feishu-adapter] Post send error, falling back to text:', err instanceof Error ? err.message : err);
    }

    // Final fallback: plain text
    try {
      const res = await this.restClient!.im.message.create({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: chatId,
          msg_type: 'text',
          content: JSON.stringify({ text }),
        },
      });
      if (res?.data?.message_id) {
        return { ok: true, messageId: res.data.message_id };
      }
      return { ok: false, error: res?.msg || 'Send failed' };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : 'Send failed' };
    }
  }

  // ── Permission card (with real action buttons) ─────────────

  /**
   * Send a permission card with real Feishu card action buttons.
   * Button clicks trigger card.action.trigger events handled by handleCardAction().
   * Falls back to text-based /perm commands if button card fails.
   */
  private async sendPermissionCard(
    chatId: string,
    text: string,
    inlineButtons: import('../types.js').InlineButton[][],
  ): Promise<SendResult> {
    if (!this.restClient) {
      return { ok: false, error: 'Feishu client not initialized' };
    }

    // Convert HTML text from permission-broker to Feishu markdown.
    // permission-broker sends HTML (<b>, <code>, <pre>, &amp; entities)
    // but Feishu card markdown elements don't understand HTML.
    const mdText = text
      .replace(/<b>(.*?)<\/b>/gi, '**$1**')
      .replace(/<code>(.*?)<\/code>/gi, '`$1`')
      .replace(/<pre>([\s\S]*?)<\/pre>/gi, '```\n$1\n```')
      .replace(/<[^>]+>/g, '')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&')
      .replace(/&quot;/g, '"');

    // Extract permissionRequestId from the first button's callback data
    const firstBtn = inlineButtons.flat()[0];
    const permId = firstBtn?.callbackData?.startsWith('perm:')
      ? firstBtn.callbackData.split(':').slice(2).join(':')
      : '';

    if (permId) {
      // Use real card action buttons
      const cardJson = buildPermissionButtonCard(mdText, permId, chatId);

      try {
        const res = await this.restClient.im.message.create({
          params: { receive_id_type: 'chat_id' },
          data: {
            receive_id: chatId,
            msg_type: 'interactive',
            content: cardJson,
          },
        });
        if (res?.data?.message_id) {
          return { ok: true, messageId: res.data.message_id };
        }
        console.warn('[feishu-adapter] Permission button card send failed:', JSON.stringify({ code: (res as any)?.code, msg: res?.msg }));
      } catch (err) {
        console.warn('[feishu-adapter] Permission button card error, falling back to text:', err instanceof Error ? err.message : err);
      }
    }

    // Fallback: text-based permission commands (same as before, for backward compat)
    const permCommands = inlineButtons.flat().map((btn) => {
      if (btn.callbackData.startsWith('perm:')) {
        const parts = btn.callbackData.split(':');
        const action = parts[1];
        const id = parts.slice(2).join(':');
        return `\`/perm ${action} ${id}\``;
      }
      return btn.text;
    });

    const cardContent = [
      mdText,
      '',
      '---',
      '**Reply:**',
      '`1` - Allow once',
      '`2` - Allow session',
      '`3` - Deny',
      '',
      'Or use full commands:',
      ...permCommands,
    ].join('\n');

    const cardJson = JSON.stringify({
      schema: '2.0',
      config: { wide_screen_mode: true },
      header: {
        template: 'orange',
        title: { tag: 'plain_text', content: '🔐 Permission Required' },
      },
      body: {
        elements: [
          { tag: 'markdown', content: cardContent },
        ],
      },
    });

    try {
      const res = await this.restClient.im.message.create({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: chatId,
          msg_type: 'interactive',
          content: cardJson,
        },
      });
      if (res?.data?.message_id) {
        return { ok: true, messageId: res.data.message_id };
      }
      console.warn('[feishu-adapter] Fallback card also failed:', res?.msg);
    } catch (err) {
      console.warn('[feishu-adapter] Fallback card error, sending plain text:', err instanceof Error ? err.message : err);
    }

    // Last resort: plain text message (works even without card permissions)
    const plainText = [
      mdText,
      '',
      '---',
      'Reply: 1 = Allow once | 2 = Allow session | 3 = Deny',
      '',
      ...permCommands,
    ].join('\n');

    try {
      const res = await this.restClient.im.message.create({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: chatId,
          msg_type: 'text',
          content: JSON.stringify({ text: plainText }),
        },
      });
      if (res?.data?.message_id) {
        return { ok: true, messageId: res.data.message_id };
      }
      return { ok: false, error: res?.msg || 'Send failed' };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : 'Send failed' };
    }
  }

  // ── Raw card send ──────────────────────────────────────────

  /**
   * Send a raw interactive card JSON to a chat.
   * Used by the pairing adapter for approval cards.
   */
  async sendRawCard(chatId: string, cardJson: string, replyToMessageId?: string): Promise<SendResult> {
    if (!this.restClient) {
      return { ok: false, error: 'Feishu client not initialized' };
    }
    try {
      let res;
      if (replyToMessageId) {
        res = await this.restClient.im.message.reply({
          path: { message_id: replyToMessageId },
          data: { content: cardJson, msg_type: 'interactive' },
        });
      } else {
        const receiveIdType = chatId.startsWith('ou_') ? 'open_id' : 'chat_id';
        res = await this.restClient.im.message.create({
          params: { receive_id_type: receiveIdType },
          data: { receive_id: chatId, msg_type: 'interactive', content: cardJson },
        });
      }
      if (res?.data?.message_id) {
        return { ok: true, messageId: res.data.message_id };
      }
      return { ok: false, error: res?.msg || 'Card send failed' };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : 'Card send failed' };
    }
  }

  /** Update an existing card message in-place via PATCH. */
  async patchCardMessage(messageId: string, cardJson: string): Promise<boolean> {
    if (!this.restClient) return false;
    try {
      await this.restClient.im.message.patch({
        path: { message_id: messageId },
        data: { content: cardJson } as any,
      });
      return true;
    } catch (err) {
      console.warn('[feishu-adapter] patchCardMessage failed:', err instanceof Error ? err.message : err);
      return false;
    }
  }

  // ── Config & Auth ───────────────────────────────────────────

  validateConfig(): string | null {
    const enabled = getBridgeContext().store.getSetting('bridge_feishu_enabled');
    if (enabled !== 'true') return 'bridge_feishu_enabled is not true';

    const appId = getBridgeContext().store.getSetting('bridge_feishu_app_id');
    if (!appId) return 'bridge_feishu_app_id not configured';

    const appSecret = getBridgeContext().store.getSetting('bridge_feishu_app_secret');
    if (!appSecret) return 'bridge_feishu_app_secret not configured';

    return null;
  }

  isAuthorized(userId: string, chatId: string): boolean {
    const allowedUsers = getBridgeContext().store.getSetting('bridge_feishu_allowed_users') || '';
    if (!allowedUsers) {
      // No restriction configured — allow all
      return true;
    }

    const allowed = allowedUsers
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);

    if (allowed.length === 0) return true;

    return allowed.includes(userId) || allowed.includes(chatId);
  }

  // ── Incoming event handler ──────────────────────────────────

  private async handleIncomingEvent(data: FeishuMessageEventData): Promise<void> {
    try {
      await this.processIncomingEvent(data);
    } catch (err) {
      console.error(
        '[feishu-adapter] Unhandled error in event handler:',
        err instanceof Error ? err.stack || err.message : err,
      );
    }
  }

  private async processIncomingEvent(data: FeishuMessageEventData): Promise<void> {
    const msg = data.message;
    const sender = data.sender;
    const isBotSender = sender.sender_type === 'bot';
    let contextOnly = false;

    // Diagnostic log for every incoming event
    console.log(
      `[feishu-adapter] EVENT msgId=${msg.message_id} chat_type=${msg.chat_type} chat_id=${msg.chat_id}` +
      ` sender_type=${sender.sender_type} msg_type=${msg.message_type}` +
      ` mentions=${JSON.stringify(msg.mentions?.map(m => ({ key: m.key, name: m.name, open_id: m.id.open_id })) || [])}` +
      ` text=${JSON.stringify(msg.content?.slice(0, 200))}`,
    );

    // [P1] Filter bot messages
    if (isBotSender) {
      const multiBotEnabled = getBridgeContext().store.getSetting('bridge_feishu_multi_bot_enabled') === 'true';
      if (!multiBotEnabled) return; // Legacy: drop all bot messages

      const senderOpenId = sender.sender_id?.open_id || '';
      if (!senderOpenId || this.botIds.has(senderOpenId)) return; // Self or unidentifiable

      // Auto-discover bot from sender
      this.registerBotFromMentions(msg.mentions);

      // For bot messages: accept if this bot is @mentioned OR if the message content contains this bot's name
      const mentioned = this.isBotMentioned(msg.mentions);
      const botName = this.knownBotsByOpenId.get(this.botOpenId || '') || '';
      const textContent = msg.content || '';
      const mentionedInText = botName && textContent.includes(botName);
      if (!mentioned && !mentionedInText) {
        // Not directed at us — store as context only
        contextOnly = true;
        console.log('[feishu-adapter] Bot message stored as context (this bot not mentioned), chatId:', msg.chat_id);
      } else {
        console.log(`[feishu-adapter] Accepting bot message from ${senderOpenId}, mentioned=${mentioned}, mentionedInText=${mentionedInText}`);
      }
    }

    // Message expiry: discard messages older than configured threshold
    if (msg.create_time && this.isTimestampExpired(msg.create_time)) {
      console.log(`[feishu-adapter] Discarding expired message, msgId: ${msg.message_id}`);
      return;
    }

    // Dedup by message_id
    if (this.seenMessageIds.has(msg.message_id)) return;
    this.addToDedup(msg.message_id);

    const chatId = msg.chat_id;
    // [P2] Complete sender ID fallback chain: open_id > user_id > union_id
    const userId = sender.sender_id?.open_id
      || sender.sender_id?.user_id
      || sender.sender_id?.union_id
      || '';
    const isGroup = msg.chat_type === 'group';

    // Track group chat IDs for relay filtering
    if (isGroup) this.groupChatIds.add(chatId);

    // Track bots observed in this group chat
    if (isGroup) {
      // Seed user name cache from mentions early (so bot detection can distinguish users)
      this.seedCacheFromMentions(msg.mentions);

      if (isBotSender) {
        const senderBotName = this.knownBotsByOpenId.get(userId);
        if (senderBotName) this.recordBotInGroup(chatId, senderBotName);
      }
      if (msg.mentions) {
        for (const m of msg.mentions) {
          const openId = m.id.open_id || '';
          if (!openId) continue;
          const botName = this.knownBotsByOpenId.get(openId);
          if (botName && !this.botIds.has(openId)) {
            this.recordBotInGroup(chatId, botName);
          }
        }
      }
    }

    // Authorization check
    if (!this.isAuthorized(userId, chatId)) {
      console.warn('[feishu-adapter] Unauthorized message from userId:', userId, 'chatId:', chatId);
      return;
    }

    // Detect @all mention (before group policy check, used later in InboundMessage)
    const mentionAll = msg.mentions?.some(m => m.key === '@_all') || false;

    // Group chat policy
    if (isGroup) {
      const policy = getBridgeContext().store.getSetting('bridge_feishu_group_policy') || 'open';

      if (policy === 'disabled') {
        console.log('[feishu-adapter] Group message ignored (policy=disabled), chatId:', chatId);
        return;
      }

      if (policy === 'allowlist') {
        const allowedGroups = (getBridgeContext().store.getSetting('bridge_feishu_group_allow_from') || '')
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);
        if (!allowedGroups.includes(chatId)) {
          console.log('[feishu-adapter] Group message ignored (not in allowlist), chatId:', chatId);
          return;
        }
      }

      // Require @mention check (with @all support)
      const requireMention = getBridgeContext().store.getSetting('bridge_feishu_require_mention') !== 'false';
      const botMentioned = this.isBotMentioned(msg.mentions);
      const respondToMentionAll = getBridgeContext().store.getSetting('bridge_feishu_respond_to_mention_all') === 'true';
      const effectiveMentioned = botMentioned || (mentionAll && respondToMentionAll);
      const isContextOnlyMsg = requireMention && !effectiveMentioned;
      if (isContextOnlyMsg) {
        // Multi-bot: store as context instead of dropping
        const multiBotEnabled = getBridgeContext().store.getSetting('bridge_feishu_multi_bot_enabled') === 'true';
        if (!multiBotEnabled) {
          console.log('[feishu-adapter] Group message ignored (bot not @mentioned), chatId:', chatId, 'msgId:', msg.message_id);
          try {
            getBridgeContext().store.insertAuditLog({
              channelType: 'feishu',
              chatId,
              direction: 'inbound',
              messageId: msg.message_id,
              summary: '[FILTERED] Group message dropped: bot not @mentioned (require_mention=true)',
            });
          } catch { /* best effort */ }
          return;
        }
        // Multi-bot enabled: fall through with contextOnly flag
        contextOnly = true;
        console.log(`[feishu-adapter] contextOnly=true for msgId=${msg.message_id} (requireMention=${requireMention}, botMentioned=${botMentioned}, multiBotEnabled=${multiBotEnabled})`);
      }
    }

    // ── User name resolution (seed cache from mentions, then batch resolve) ──
    this.seedCacheFromMentions(msg.mentions);
    // Await sender name resolution (needed for system prompt label);
    // batch-resolve mentioned users in background (cosmetic only).
    if (!isBotSender && !this.userNameCache.has(userId)) {
      await this.resolveUserName(userId);
    }
    const mentionIds = (msg.mentions || [])
      .map(m => m.id.open_id)
      .filter((id): id is string => !!id && id !== userId);
    if (mentionIds.length > 0) {
      this.batchResolveUserNames(mentionIds).catch(() => {});
    }

    // ── Chat info resolution (group name, chat mode) ──
    let groupName: string | undefined;
    let groupChatMode: string | undefined;
    if (isGroup) {
      const chatInfo = await this.resolveChatInfo(chatId);
      if (chatInfo) {
        groupName = chatInfo.name || undefined;
        groupChatMode = chatInfo.chatMode;
      }
    }

    // ── Thread ID extraction ──
    const threadId = msg.root_id || msg.thread_id || undefined;

    // Track last message ID per chat for typing indicator
    // Only update for messages that will actually be processed (not contextOnly),
    // otherwise the streaming card may reply to the wrong message.
    if (!contextOnly) {
      this.lastIncomingMessageId.set(chatId, msg.message_id);
    }

    // ── Phase 7: Abort fast-path ──
    // If the message looks like an abort trigger and there is an active
    // streaming card, finalize it immediately (before entering the queue).
    if (msg.message_type === 'text') {
      const rawText = this.parseTextContent(msg.content).trim();
      if (ABORT_PATTERNS.test(rawText) && this.activeCards.has(chatId)) {
        console.log(`[feishu-adapter] Abort fast-path triggered for chat ${chatId} (text="${rawText}")`);
        this.finalizeCard(chatId, 'interrupted', '').catch(() => {});
        // Still enqueue the message so bridge-manager can handle the abort
      }
    }

    // ── Phase 7b: Quote-interrupt ──
    // If the user replies to the bot's currently streaming card message,
    // treat it as an interrupt (like /stop) without destroying the session.
    if (msg.parent_id && this.activeCards.has(chatId)) {
      const activeState = this.activeCards.get(chatId)!;
      if (activeState.messageId && activeState.messageId === msg.parent_id) {
        console.log(`[feishu-adapter] Quote-interrupt triggered for chat ${chatId} (parent_id=${msg.parent_id})`);
        this.finalizeCard(chatId, 'interrupted', '').catch(() => {});
        // Enqueue synthetic /stop so bridge-manager aborts the backend task
        const address = { channelType: 'feishu' as const, chatId, userId };
        this.enqueue({
          messageId: msg.message_id,
          address,
          text: '/stop',
          timestamp: parseInt(msg.create_time, 10) || Date.now(),
          isGroup,
        });
        return;
      }
    }

    // Extract content based on message type
    const messageType = msg.message_type;
    let text = '';
    const attachments: FileAttachment[] = [];

    if (messageType === 'text') {
      text = this.parseTextContent(msg.content);
    } else if (messageType === 'image') {
      // [P1] Download image with failure fallback
      console.log('[feishu-adapter] Image message received, content:', msg.content);
      const fileKey = this.extractFileKey(msg.content);
      console.log('[feishu-adapter] Extracted fileKey:', fileKey);
      if (fileKey) {
        const attachment = await this.downloadResource(msg.message_id, fileKey, 'image');
        if (attachment) {
          attachments.push(attachment);
        } else {
          text = '[image download failed]';
          try {
            getBridgeContext().store.insertAuditLog({
              channelType: 'feishu',
              chatId,
              direction: 'inbound',
              messageId: msg.message_id,
              summary: `[ERROR] Image download failed for key: ${fileKey}`,
            });
          } catch { /* best effort */ }
        }
      }
    } else if (messageType === 'file' || messageType === 'audio' || messageType === 'video' || messageType === 'media') {
      // [P2] Support file/audio/video/media downloads
      const fileKey = this.extractFileKey(msg.content);
      if (fileKey) {
        // Try to extract original filename from content JSON
        let fileName: string | undefined;
        try {
          const parsed = JSON.parse(msg.content);
          fileName = parsed.file_name || parsed.fileName || undefined;
        } catch { /* ignore */ }

        const resourceType = messageType === 'audio' || messageType === 'video' || messageType === 'media'
          ? messageType
          : 'file';
        const attachment = await this.downloadResource(msg.message_id, fileKey, resourceType);
        if (attachment) {
          // Override name and MIME if we have the original filename
          if (fileName) {
            attachment.name = fileName;
            const ext = fileName.split('.').pop()?.toLowerCase();
            if (ext === 'pdf') attachment.type = 'application/pdf';
            else if (ext === 'txt' || ext === 'md' || ext === 'csv' || ext === 'log') attachment.type = 'text/plain';
            else if (ext === 'json') attachment.type = 'application/json';
            else if (ext === 'html' || ext === 'htm') attachment.type = 'text/html';
            else if (ext === 'xml') attachment.type = 'text/xml';
            else if (ext === 'py' || ext === 'js' || ext === 'ts' || ext === 'java' || ext === 'go' || ext === 'rs' || ext === 'c' || ext === 'cpp' || ext === 'rb' || ext === 'sh') attachment.type = 'text/plain';
            else if (ext === 'doc' || ext === 'docx') attachment.type = 'application/msword';
            else if (ext === 'xls' || ext === 'xlsx') attachment.type = 'application/vnd.ms-excel';
          }
          attachments.push(attachment);
        } else {
          text = `[${messageType} download failed]`;
          try {
            getBridgeContext().store.insertAuditLog({
              channelType: 'feishu',
              chatId,
              direction: 'inbound',
              messageId: msg.message_id,
              summary: `[ERROR] ${messageType} download failed for key: ${fileKey}`,
            });
          } catch { /* best effort */ }
        }
      }
    } else if (messageType === 'post') {
      // [P2] Extract text and image keys from rich text (post) messages
      const { extractedText, imageKeys } = this.parsePostContent(msg.content);
      text = extractedText;
      for (const key of imageKeys) {
        const attachment = await this.downloadResource(msg.message_id, key, 'image');
        if (attachment) {
          attachments.push(attachment);
        }
        // Don't add fallback text for individual post images — the text already carries context
      }
    } else if (messageType === 'interactive') {
      // Card message — recursively extract text from card elements
      text = this.parseCardContent(msg.content);
      if (!text) {
        console.log(`[feishu-adapter] Card message with no extractable text, msgId: ${msg.message_id}`);
        return;
      }
    } else if (messageType === 'merge_forward') {
      text = await this.parseMergeForward(msg.message_id, msg.content);
    } else if (messageType === 'sticker') {
      text = this.parseStickerContent(msg.content);
    } else if (messageType === 'share_chat') {
      text = this.parseShareChatContent(msg.content);
    } else if (messageType === 'share_user') {
      text = this.parseShareUserContent(msg.content);
    } else if (messageType === 'location') {
      text = this.parseLocationContent(msg.content);
    } else if (['calendar', 'share_calendar_event', 'general_calendar', 'video_chat', 'todo', 'vote'].includes(messageType)) {
      text = `[${messageType} 消息]`;
    } else if (['system', 'hongbao', 'folder'].includes(messageType)) {
      // System/hongbao/folder messages are informational, skip
      return;
    } else {
      // Unsupported type — log and skip
      console.log(`[feishu-adapter] Unsupported message type: ${messageType}, msgId: ${msg.message_id}`);
      return;
    }

    // Strip @mention markers from text
    text = this.resolveMentionMarkers(text, msg.mentions, isGroup ? chatId : undefined);

    // Fetch quoted message content if this is a reply
    if (msg.parent_id) {
      const quoted = await this.fetchQuotedMessage(msg.parent_id);
      if (quoted) {
        if (quoted.text) {
          const quotedLabel = quoted.senderName ? `${quoted.senderName}: ` : '';
          text = `[引用消息] ${quotedLabel}${quoted.text} [/引用消息]\n\n${text}`;
        }
        if (quoted.attachments) {
          attachments.push(...quoted.attachments);
        }
      }
    }

    if (!text.trim() && attachments.length === 0) return;

    const timestamp = parseInt(msg.create_time, 10) || Date.now();
    const address = {
      channelType: 'feishu' as const,
      chatId,
      userId,
    };

    // [P1] Check for /perm text command (permission approval fallback)
    const trimmedText = text.trim();
    if (trimmedText.startsWith('/perm ')) {
      const permParts = trimmedText.split(/\s+/);
      // /perm <action> <permId>
      if (permParts.length >= 3) {
        const action = permParts[1]; // allow / allow_session / deny
        const permId = permParts.slice(2).join(' ');
        const callbackData = `perm:${action}:${permId}`;

        const inbound: InboundMessage = {
          messageId: msg.message_id,
          address,
          text: trimmedText,
          timestamp,
          callbackData,
          isGroup,
        };
        this.enqueue(inbound);
        return;
      }
    }

    const groupBotNames = isGroup ? this.getGroupBotNames(chatId) : undefined;

    const inbound: InboundMessage = {
      messageId: msg.message_id,
      address,
      text: text.trim(),
      timestamp,
      attachments: attachments.length > 0 ? attachments : undefined,
      senderType: isBotSender ? 'bot' : 'user',
      senderName: isBotSender
        ? (this.knownBotsByOpenId.get(userId) || userId)
        : (this.userNameCache.get(userId) || undefined),
      contextOnly: contextOnly || undefined,
      isGroup,
      groupBotNames: groupBotNames && groupBotNames.length > 0 ? groupBotNames : undefined,
      threadId,
      mentionAll: mentionAll || undefined,
      groupName,
      groupChatMode,
    };

    // Audit log
    try {
      const summary = attachments.length > 0
        ? `[${attachments.length} attachment(s)] ${text.slice(0, 150)}`
        : text.slice(0, 200);
      getBridgeContext().store.insertAuditLog({
        channelType: 'feishu',
        chatId,
        direction: 'inbound',
        messageId: msg.message_id,
        summary,
      });
    } catch { /* best effort */ }

    this.enqueue(inbound);
  }

  // ── Content parsing ─────────────────────────────────────────

  /**
   * Fetch the content of a quoted/replied message via Feishu REST API.
   * Returns text and/or attachments from the quoted message.
   */
  private async fetchQuotedMessage(parentId: string): Promise<{ text?: string; attachments?: FileAttachment[]; senderName?: string } | null> {
    if (!this.restClient) return null;
    try {
      const res = await this.restClient.im.message.get({
        path: { message_id: parentId },
      });
      const item = (res as any)?.data?.items?.[0];
      if (!item) return null;

      // Resolve quoted message sender name
      const senderOpenId = item.sender?.id || '';
      const senderName = senderOpenId
        ? (this.userNameCache.get(senderOpenId) || await this.resolveUserName(senderOpenId) || undefined)
        : undefined;

      const result = await this.extractQuotedContent(item);
      return result ? { ...result, senderName } : null;
    } catch (err) {
      console.warn('[feishu-adapter] Failed to fetch quoted message:', parentId, err);
      return null;
    }
  }

  /** Extract text/attachments from a fetched message item (used by fetchQuotedMessage). */
  private async extractQuotedContent(item: any): Promise<{ text?: string; attachments?: FileAttachment[] } | null> {
    const msgType = item.msg_type || 'text';
    const content = item.body?.content || '';

    if (msgType === 'text') {
      return { text: this.parseTextContent(content) || undefined };
    }

    if (msgType === 'post') {
      const { extractedText, imageKeys } = this.parsePostContent(content);
      const atts: FileAttachment[] = [];
      for (const key of imageKeys) {
        const att = await this.downloadResource(item.message_id, key, 'image');
        if (att) atts.push(att);
      }
      return { text: extractedText || undefined, attachments: atts.length > 0 ? atts : undefined };
    }

    if (msgType === 'image') {
      const fileKey = this.extractFileKey(content);
      if (fileKey) {
        const att = await this.downloadResource(item.message_id, fileKey, 'image');
        if (att) return { text: '[引用了一张图片]', attachments: [att] };
      }
      return { text: '[引用了一张图片，但下载失败]' };
    }

    if (msgType === 'file') {
      const fileKey = this.extractFileKey(content);
      if (fileKey) {
        let fileName: string | undefined;
        try {
          const parsed = JSON.parse(content);
          fileName = parsed.file_name || parsed.fileName || undefined;
        } catch { /* ignore */ }
        const att = await this.downloadResource(item.message_id, fileKey, 'file');
        if (att) {
          if (fileName) {
            att.name = fileName;
            const ext = fileName.split('.').pop()?.toLowerCase();
            if (ext === 'pdf') att.type = 'application/pdf';
            else if (ext === 'txt' || ext === 'md' || ext === 'csv' || ext === 'log') att.type = 'text/plain';
            else if (ext === 'json') att.type = 'application/json';
          }
          return { text: `[引用了文件: ${att.name}]`, attachments: [att] };
        }
      }
      return { text: '[引用了一个文件，但下载失败]' };
    }

    if (msgType === 'interactive') {
      let cardText = this.parseCardContent(content);
      // Filter out Feishu's degraded placeholder text
      if (cardText) {
        cardText = cardText.replace(/请升级至最新版本客户端[，,]?以查看内容/g, '').trim();
      }
      return { text: cardText || '[引用了一条卡片消息，但飞书API不返回卡片原始内容，请直接复制文字发送]' };
    }

    if (msgType === 'audio') return { text: '[引用了一条语音消息]' };
    if (msgType === 'video') return { text: '[引用了一条视频消息]' };
    if (msgType === 'media') return { text: '[引用了一条媒体消息]' };

    return { text: `[引用了一条${msgType}消息]` };
  }

  private parseTextContent(content: string): string {
    try {
      const parsed = JSON.parse(content);
      return parsed.text || '';
    } catch {
      return content;
    }
  }

  /**
   * Extract file key from message content JSON.
   * Handles multiple key names: image_key, file_key, imageKey, fileKey.
   */
  private extractFileKey(content: string): string | null {
    try {
      const parsed = JSON.parse(content);
      return parsed.image_key || parsed.file_key || parsed.imageKey || parsed.fileKey || null;
    } catch {
      return null;
    }
  }

  /**
   * Parse rich text (post) content.
   * Extracts plain text from text elements and image keys from img elements.
   */
  private parsePostContent(content: string): { extractedText: string; imageKeys: string[] } {
    const imageKeys: string[] = [];
    const textParts: string[] = [];

    try {
      const parsed = JSON.parse(content);
      // Post content structure: { title, content: [[{tag, text/image_key}]] }
      const title = parsed.title;
      if (title) textParts.push(title);

      const paragraphs = parsed.content;
      if (Array.isArray(paragraphs)) {
        for (const paragraph of paragraphs) {
          if (!Array.isArray(paragraph)) continue;
          for (const element of paragraph) {
            if (element.tag === 'text' && element.text) {
              textParts.push(element.text);
            } else if (element.tag === 'a' && element.text) {
              textParts.push(element.text);
            } else if (element.tag === 'at' && element.user_id) {
              // Mention in post — handled by isBotMentioned for group policy
            } else if (element.tag === 'img') {
              const key = element.image_key || element.file_key || element.imageKey;
              if (key) imageKeys.push(key);
            }
          }
          textParts.push('\n');
        }
      }
    } catch {
      // Failed to parse post content
    }

    return { extractedText: textParts.join('').trim(), imageKeys };
  }

  /**
   * Parse card (interactive) message content, recursively extracting text
   * from all element types including nested containers.
   */
  private parseCardContent(content: string): string {
    try {
      const parsed = JSON.parse(content);
      const parts: string[] = [];

      // Card header title
      const header = parsed.header;
      if (header?.title?.content) {
        parts.push(header.title.content);
      } else if (typeof parsed.title === 'string' && parsed.title.trim()) {
        // Feishu API degraded format: title is a plain string
        parts.push(parsed.title);
      }

      // Template card: data.template_variable may contain text fields
      if (parsed.type === 'template' && parsed.data?.template_variable) {
        const vars = parsed.data.template_variable;
        for (const val of Object.values(vars)) {
          if (typeof val === 'string' && val.trim()) {
            parts.push(val);
          }
        }
      }

      // Body elements (CardKit v1 / v2)
      const elements = parsed.body?.elements || parsed.elements || [];
      this.extractCardElements(elements, parts);

      return parts.join('\n').trim();
    } catch {
      return '';
    }
  }

  /**
   * Recursively extract text from card element tree.
   */
  private extractCardElements(elements: any[], parts: string[]): void {
    if (!Array.isArray(elements)) return;

    for (const el of elements) {
      if (!el) continue;

      // Handle nested arrays (e.g. Feishu API returns elements as [[...]])
      if (Array.isArray(el)) {
        this.extractCardElements(el, parts);
        continue;
      }

      if (typeof el !== 'object') continue;
      const tag = el.tag;

      // Direct text content
      if (tag === 'markdown' || tag === 'plain_text' || tag === 'lark_md') {
        if (el.content) parts.push(el.content);
      } else if (tag === 'text') {
        // Feishu API degraded card format uses {tag:"text", text:"..."}
        if (el.text) parts.push(el.text);
        else if (el.content) parts.push(el.content);
      } else if (tag === 'div') {
        // div can have text field or nested fields
        if (el.text?.content) parts.push(el.text.content);
        if (el.fields) {
          for (const f of el.fields) {
            if (f?.text?.content) parts.push(f.text.content);
          }
        }
      } else if (tag === 'rich_text') {
        if (el.content) parts.push(el.content);
      } else if (tag === 'note') {
        // Note element has an elements array
        if (Array.isArray(el.elements)) {
          for (const ne of el.elements) {
            if (ne?.content) parts.push(ne.content);
            if (ne?.text?.content) parts.push(ne.text.content);
          }
        }
      }

      // Containers — recurse into children
      if (tag === 'collapsible_panel') {
        // Header text
        if (el.header?.title?.content) parts.push(el.header.title.content);
        this.extractCardElements(el.elements || el.body?.elements || [], parts);
      } else if (tag === 'column_set') {
        for (const col of el.columns || []) {
          this.extractCardElements(col.elements || [], parts);
        }
      } else if (tag === 'form') {
        this.extractCardElements(el.elements || [], parts);
      } else if (tag === 'interactive_container' || tag === 'card_link') {
        this.extractCardElements(el.elements || [], parts);
      }

      // Generic fallback: if element has nested elements we haven't handled
      if (el.elements && !['collapsible_panel', 'column_set', 'form', 'note',
          'interactive_container', 'card_link'].includes(tag)) {
        this.extractCardElements(el.elements, parts);
      }
    }
  }

  // ── Bot identity ────────────────────────────────────────────

  /**
   * Resolve bot identity via the Feishu REST API /bot/v3/info/.
   * Collects all available bot IDs for comprehensive mention matching.
   */
  private async resolveBotIdentity(
    appId: string,
    appSecret: string,
    domain: lark.Domain,
  ): Promise<void> {
    try {
      const baseUrl = domain === lark.Domain.Lark
        ? 'https://open.larksuite.com'
        : 'https://open.feishu.cn';

      const tokenRes = await fetch(`${baseUrl}/open-apis/auth/v3/tenant_access_token/internal`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
        signal: AbortSignal.timeout(10_000),
      });
      const tokenData: any = await tokenRes.json();
      if (!tokenData.tenant_access_token) {
        console.warn('[feishu-adapter] Failed to get tenant access token');
        return;
      }

      const botRes = await fetch(`${baseUrl}/open-apis/bot/v3/info/`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${tokenData.tenant_access_token}` },
        signal: AbortSignal.timeout(10_000),
      });
      const botData: any = await botRes.json();
      if (botData?.bot?.open_id) {
        this.botOpenId = botData.bot.open_id;
        this.botIds.add(botData.bot.open_id);
        // Register own name for relay senderName
        if (botData.bot.app_name) {
          this.knownBotsByOpenId.set(botData.bot.open_id, botData.bot.app_name);
          this.botName = botData.bot.app_name;
          console.log(`[feishu-adapter] Bot identity: ${botData.bot.app_name} (${botData.bot.open_id})`);
        }
      }
      // Also record app_id-based IDs if available
      if (botData?.bot?.bot_id) {
        this.botIds.add(botData.bot.bot_id);
      }
      if (!this.botOpenId) {
        console.warn('[feishu-adapter] Could not resolve bot open_id');
      }
    } catch (err) {
      console.warn(
        '[feishu-adapter] Failed to resolve bot identity:',
        err instanceof Error ? err.message : err,
      );
    }
  }

  /** Load known bots from config settings. */
  private loadKnownBots(): void {
    const raw = getBridgeContext().store.getSetting('bridge_feishu_known_bots') || '';
    if (!raw) return;
    for (const pair of raw.split(',')) {
      const [name, openId] = pair.split(':').map(s => s.trim());
      if (name && openId) {
        this.knownBots.set(name.toLowerCase(), openId);
        this.knownBotsByOpenId.set(openId, name);
        console.log(`[feishu-adapter] Loaded known bot: ${name} -> ${openId}`);
      }
    }
  }

  /**
   * Record a bot as observed in a group chat.
   * Called when we see a bot message or a bot @mention in a group.
   */
  recordBotInGroup(chatId: string, botName: string): void {
    let bots = this.groupObservedBots.get(chatId);
    if (!bots) {
      bots = new Set();
      this.groupObservedBots.set(chatId, bots);
    }
    bots.add(botName);
  }

  /**
   * Get bot names observed in a group chat.
   * Falls back to empty array if no bots have been seen yet.
   */
  getGroupBotNames(chatId: string): string[] {
    const bots = this.groupObservedBots.get(chatId);
    return bots ? Array.from(bots) : [];
  }

  /** Auto-discover bots from message mentions (called for ALL group messages).
   *  Skips @all, self, and IDs already known as human users (in userNameCache). */
  private registerBotFromMentions(
    mentions?: FeishuMessageEventData['message']['mentions'],
  ): void {
    if (!mentions) return;
    for (const m of mentions) {
      if (m.key === '@_all') continue; // Skip @all
      const openId = m.id.open_id;
      if (!openId) continue;
      if (this.botIds.has(openId)) continue; // Skip self
      if (this.knownBotsByOpenId.has(openId)) continue; // Already known bot
      if (this.userNameCache.has(openId)) continue; // Known human user — don't register as bot
      this.knownBots.set(m.name.toLowerCase(), openId);
      this.knownBotsByOpenId.set(openId, m.name);
      console.log(`[feishu-adapter] Auto-discovered bot from mention: ${m.name} -> ${openId}`);
    }
  }

  // ── @Mention detection ──────────────────────────────────────

  /**
   * [P2] Check if bot is mentioned — matches against open_id, user_id, union_id.
   */
  private isBotMentioned(
    mentions?: FeishuMessageEventData['message']['mentions'],
  ): boolean {
    if (!mentions || this.botIds.size === 0) return false;
    return mentions.some((m) => {
      const ids = [m.id.open_id, m.id.user_id, m.id.union_id].filter(Boolean) as string[];
      return ids.some((id) => this.botIds.has(id));
    });
  }

  /**
   * Resolve mention placeholders: strip self-mentions, replace others with @Name.
   * Also registers unknown mentions as potential bots so outbound @mentions resolve.
   * False positives (human users) are cleaned up later by unregisterUserFromBots()
   * once resolveUserName confirms them as real users.
   */
  private resolveMentionMarkers(
    text: string,
    mentions?: FeishuMessageEventData['message']['mentions'],
    chatId?: string,
  ): string {
    if (!mentions || mentions.length === 0) {
      return text.replace(/@_user_\d+/g, '').trim();
    }
    for (const m of mentions) {
      if (m.key === '@_all') continue;
      const ids = [m.id.open_id, m.id.user_id, m.id.union_id].filter(Boolean) as string[];
      const isSelf = ids.some(id => this.botIds.has(id));
      if (isSelf) {
        text = text.replace(new RegExp(escapeRegex(m.key), 'g'), '');
      } else {
        text = text.replace(new RegExp(escapeRegex(m.key), 'g'), `@${m.name}`);
        // Register as potential bot if not already known (enables outbound @mention resolution).
        // False positives are cleaned up by unregisterUserFromBots() after user name resolution.
        const openId = m.id.open_id;
        if (openId && !this.knownBotsByOpenId.has(openId)) {
          this.knownBots.set(m.name.toLowerCase(), openId);
          this.knownBotsByOpenId.set(openId, m.name);
          console.log(`[feishu-adapter] Registered mention as potential bot: ${m.name} -> ${openId}`);
          if (chatId) this.recordBotInGroup(chatId, m.name);
        }
      }
    }
    return text.trim();
  }

  /**
   * Resolve outbound @[BotName] mentions to Feishu mention markup.
   */
  private resolveOutboundMentions(text: string, format: 'post' | 'card' = 'post'): string {
    if (this.knownBots.size > 0) {
      console.log(`[feishu-adapter] resolveOutboundMentions: format=${format}, knownBots=[${Array.from(this.knownBots.entries()).map(([n,id]) => `${n}:${id.slice(0,10)}`).join(', ')}], text preview="${text.slice(0, 100)}"`);
    }
    // First: @[BotName] format
    text = text.replace(/@\[([^\]]+)\]/g, (match, name: string) => {
      const openId = this.knownBots.get(name.toLowerCase());
      if (!openId) return match;
      return format === 'card'
        ? `<at id=${openId}></at>`
        : `<at user_id="${openId}">${name}</at>`;
    });
    // Second: @BotName format (known bots only, avoid false positives)
    for (const [name, openId] of this.knownBots) {
      const pattern = new RegExp(`@${escapeRegex(name)}(?![\\w\\[])`, 'gi');
      const replacement = format === 'card'
        ? `<at id=${openId}></at>`
        : `<at user_id="${openId}">${name}</at>`;
      text = text.replace(pattern, replacement);
    }
    // Third: @UserName format (from userNameCache, reverse lookup)
    for (const [openId, userName] of this.userNameCache.entries()) {
      if (!userName) continue;
      const pattern = new RegExp(`@${escapeRegex(userName)}(?![\\w\\[])`, 'gi');
      if (pattern.test(text)) {
        const replacement = format === 'card'
          ? `<at id=${openId}></at>`
          : `<at user_id="${openId}">${userName}</at>`;
        text = text.replace(pattern, replacement);
      }
    }
    return text;
  }

  // ── Resource download ───────────────────────────────────────

  /**
   * Download a message resource (image/file/audio/video) via SDK.
   * Returns null on failure (caller decides fallback behavior).
   */
  private async downloadResource(
    messageId: string,
    fileKey: string,
    resourceType: string,
  ): Promise<FileAttachment | null> {
    if (!this.restClient) return null;

    try {
      console.log(`[feishu-adapter] Downloading resource: type=${resourceType}, key=${fileKey}, msgId=${messageId}`);

      const res = await this.restClient.im.messageResource.get({
        path: {
          message_id: messageId,
          file_key: fileKey,
        },
        params: {
          type: resourceType === 'image' ? 'image' : 'file',
        },
      });

      if (!res) {
        console.warn('[feishu-adapter] messageResource.get returned null/undefined');
        return null;
      }

      // SDK returns { writeFile, getReadableStream, headers }
      // Try stream approach first, fall back to writeFile + read if stream fails
      let buffer: Buffer;

      try {
        const readable = res.getReadableStream();
        const chunks: Buffer[] = [];
        let totalSize = 0;

        for await (const chunk of readable) {
          const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          totalSize += buf.length;
          if (totalSize > MAX_FILE_SIZE) {
            console.warn(`[feishu-adapter] Resource too large (>${MAX_FILE_SIZE} bytes), key: ${fileKey}`);
            return null;
          }
          chunks.push(buf);
        }
        buffer = Buffer.concat(chunks);
      } catch (streamErr) {
        // Stream approach failed — fall back to writeFile + read
        console.warn('[feishu-adapter] Stream read failed, falling back to writeFile:', streamErr instanceof Error ? streamErr.message : streamErr);

        const fs = await import('fs');
        const os = await import('os');
        const path = await import('path');
        const tmpPath = path.join(os.tmpdir(), `feishu-dl-${crypto.randomUUID()}`);
        try {
          await res.writeFile(tmpPath);
          buffer = fs.readFileSync(tmpPath);
          if (buffer.length > MAX_FILE_SIZE) {
            console.warn(`[feishu-adapter] Resource too large (>${MAX_FILE_SIZE} bytes), key: ${fileKey}`);
            return null;
          }
        } finally {
          try { fs.unlinkSync(tmpPath); } catch { /* ignore cleanup errors */ }
        }
      }

      if (!buffer || buffer.length === 0) {
        console.warn('[feishu-adapter] Downloaded resource is empty, key:', fileKey);
        return null;
      }

      const base64 = buffer.toString('base64');
      const id = crypto.randomUUID();
      const mimeType = MIME_BY_TYPE[resourceType] || 'application/octet-stream';
      const ext = resourceType === 'image' ? 'png'
        : resourceType === 'audio' ? 'ogg'
        : resourceType === 'video' ? 'mp4'
        : 'bin';

      console.log(`[feishu-adapter] Resource downloaded: ${buffer.length} bytes, key=${fileKey}`);

      return {
        id,
        name: `${fileKey}.${ext}`,
        type: mimeType,
        size: buffer.length,
        data: base64,
      };
    } catch (err) {
      console.error(
        `[feishu-adapter] Resource download failed (type=${resourceType}, key=${fileKey}):`,
        err instanceof Error ? err.stack || err.message : err,
      );
      return null;
    }
  }

  // ── Utilities ───────────────────────────────────────────────

  private addToDedup(messageId: string): void {
    this.seenMessageIds.set(messageId, true);
  }

  /** Check if a Feishu timestamp (ms string) is older than the configured expiry. */
  private isTimestampExpired(timestampStr: string): boolean {
    const expiryMinutes = parseInt(
      getBridgeContext().store.getSetting('bridge_feishu_message_expiry_minutes') || '30', 10,
    );
    if (expiryMinutes <= 0) return false;
    const age = Date.now() - parseInt(timestampStr, 10);
    return age > expiryMinutes * 60 * 1000;
  }

  /** Extract plain text from a message item (best-effort, for excerpts). */
  private extractPlainText(item: any): string {
    try {
      const msgType = item.msg_type || 'text';
      if (msgType === 'text') return this.parseTextContent(item.body?.content || '');
      if (msgType === 'post') return this.parsePostContent(item.body?.content || '').extractedText;
      if (msgType === 'interactive') return this.parseCardContent(item.body?.content || '');
    } catch { /* best effort */ }
    return '';
  }

  // ── User Name Resolution ──────────────────────────────────

  /** Resolve a single user's display name via contact.user.get API. */
  private async resolveUserName(openId: string): Promise<string | undefined> {
    const cached = this.userNameCache.get(openId);
    if (cached !== undefined) return cached || undefined; // '' → undefined
    if (!this.restClient) return undefined;
    try {
      const res = await this.restClient.contact.user.get({
        path: { user_id: openId },
        params: { user_id_type: 'open_id' },
      });
      const user = (res as any)?.data?.user;
      const name = user?.name || user?.display_name || user?.nickname || user?.en_name || '';
      this.userNameCache.set(openId, name); // cache even '' to avoid repeated API calls
      // If this openId was speculatively registered as a bot, clean it up
      if (name) this.unregisterUserFromBots(openId);
      return name || undefined;
    } catch (err) {
      console.warn('[feishu-adapter] resolveUserName failed:', openId, err instanceof Error ? err.message : err);
    }
    return undefined;
  }

  /** Remove an openId from knownBots/groupObservedBots if it was confirmed as a human user.
   *  Called after resolveUserName succeeds — cleans up speculative bot registrations. */
  private unregisterUserFromBots(openId: string): void {
    const botName = this.knownBotsByOpenId.get(openId);
    if (!botName) return;
    this.knownBotsByOpenId.delete(openId);
    this.knownBots.delete(botName.toLowerCase());
    // Remove from all group observed bots
    for (const [, bots] of this.groupObservedBots) {
      bots.delete(botName);
    }
    console.log(`[feishu-adapter] Unregistered user from bots: ${botName} (${openId}) — confirmed as human user`);
  }

  /** Batch resolve user names via contact/v3/users/batch (chunks of 50). */
  private async batchResolveUserNames(openIds: string[]): Promise<void> {
    if (!this.restClient) return;
    const unresolved = this.userNameCache.filterMissing(openIds);
    if (unresolved.length === 0) return;
    const unique = [...new Set(unresolved)];
    for (let i = 0; i < unique.length; i += 50) {
      const chunk = unique.slice(i, i + 50);
      try {
        const res = await (this.restClient.contact.user as any).batch({
          params: { user_ids: chunk, user_id_type: 'open_id' },
        });
        const items = (res as any)?.data?.items || [];
        for (const item of items) {
          const id = item.user_id || item.open_id;
          const name = item.name || item.display_name || item.nickname || item.en_name || '';
          if (id) {
            this.userNameCache.set(id, name);
            if (name) this.unregisterUserFromBots(id);
          }
        }
        // Cache empty for IDs the API didn't return
        for (const id of chunk) {
          if (!this.userNameCache.has(id)) this.userNameCache.set(id, '');
        }
      } catch (err) {
        console.warn('[feishu-adapter] batchResolveUserNames failed:', err instanceof Error ? err.message : err);
        // Fallback: resolve individually
        for (const id of chunk) {
          if (!this.userNameCache.has(id)) await this.resolveUserName(id);
        }
      }
    }
  }

  /** Seed user name cache from mention payloads (free, no API call). */
  private seedCacheFromMentions(mentions?: FeishuMessageEventData['message']['mentions']): void {
    if (!mentions) return;
    for (const m of mentions) {
      if (m.key === '@_all') continue;
      const openId = m.id.open_id;
      if (!openId || !m.name) continue;
      if (this.botIds.has(openId)) continue; // Skip self
      if (!this.userNameCache.has(openId)) {
        this.userNameCache.set(openId, m.name);
      }
    }
  }

  // ── Chat Info Resolution ──────────────────────────────────

  /** Resolve group chat info via im.chat.get API, cache result. */
  private async resolveChatInfo(chatId: string): Promise<{ name: string; chatMode?: string; groupMessageType?: string } | undefined> {
    const cached = this.chatInfoCache.get(chatId);
    if (cached !== undefined) return cached;
    if (!this.restClient) return undefined;
    try {
      const res = await this.restClient.im.chat.get({ path: { chat_id: chatId } });
      const data = (res as any)?.data;
      if (data) {
        const info = {
          name: data.name || '',
          chatMode: data.chat_mode as string | undefined,
          groupMessageType: data.group_message_type as string | undefined,
        };
        this.chatInfoCache.set(chatId, info);
        return info;
      }
    } catch (err) {
      console.warn('[feishu-adapter] resolveChatInfo failed:', chatId, err instanceof Error ? err.message : err);
    }
    return undefined;
  }

  // ── Message Type Converters ───────────────────────────────

  /** Parse merge_forward (forwarded message bundle) — expand sub-messages with sender attribution. */
  private async parseMergeForward(messageId: string, content: string): Promise<string> {
    if (!this.restClient) return '[转发消息，无法展开]';
    try {
      // merge_forward content may contain inline message list or require API fetch
      let items: any[] | undefined;
      try {
        const parsed = JSON.parse(content);
        // Some merge_forward payloads embed messages directly
        items = parsed.message_list || parsed.messages || parsed.items;
      } catch { /* not inline, fetch via API */ }

      if (!items || items.length === 0) {
        const res = await this.restClient.im.message.get({
          path: { message_id: messageId },
        });
        items = (res as any)?.data?.items;
      }
      if (!items || items.length === 0) return '[转发消息，无内容]';

      // Batch resolve sender names
      const senderIds = items.map((it: any) => it.sender?.id).filter(Boolean) as string[];
      if (senderIds.length > 0) await this.batchResolveUserNames(senderIds);

      const lines: string[] = ['<forwarded_messages>'];
      for (const item of items.slice(0, 20)) {
        const senderId = item.sender?.id || '';
        const senderName = this.userNameCache.get(senderId) || senderId;
        const createTime = item.create_time
          ? new Date(parseInt(item.create_time, 10)).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })
          : '';
        const subText = this.extractPlainText(item) || `[${item.msg_type || 'unknown'}]`;
        lines.push(`[${createTime}] ${senderName}: ${subText}`);
      }
      lines.push('</forwarded_messages>');
      return lines.join('\n');
    } catch (err) {
      console.warn('[feishu-adapter] parseMergeForward failed:', err instanceof Error ? err.message : err);
      return '[转发消息，展开失败]';
    }
  }

  private parseStickerContent(content: string): string {
    try {
      const parsed = JSON.parse(content);
      return `[表情: ${parsed.sticker_id || 'unknown'}]`;
    } catch { return '[表情]'; }
  }

  private parseShareChatContent(content: string): string {
    try {
      const parsed = JSON.parse(content);
      return `[分享群聊: ${parsed.chat_id || 'unknown'}]`;
    } catch { return '[分享群聊]'; }
  }

  private parseShareUserContent(content: string): string {
    try {
      const parsed = JSON.parse(content);
      return `[分享联系人: ${parsed.user_id || 'unknown'}]`;
    } catch { return '[分享联系人]'; }
  }

  private parseLocationContent(content: string): string {
    try {
      const parsed = JSON.parse(content);
      const name = parsed.name || '';
      const lat = parsed.latitude || '';
      const lng = parsed.longitude || '';
      return `[位置: ${name} (${lat}, ${lng})]`;
    } catch { return '[位置]'; }
  }
}

// Self-register so bridge-manager can create FeishuAdapter via the registry.
registerAdapterFactory('feishu', () => new FeishuAdapter());
