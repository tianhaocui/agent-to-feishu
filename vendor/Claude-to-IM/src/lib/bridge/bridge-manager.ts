/**
 * Bridge Manager — singleton orchestrator for the multi-IM bridge system.
 *
 * Manages adapter lifecycles, routes inbound messages through the
 * conversation engine, and coordinates permission handling.
 *
 * Uses globalThis to survive Next.js HMR in development.
 */

import type { BridgeStatus, ChannelBinding, InboundMessage, OutboundMessage, StreamingPreviewState, ToolCallInfo } from './types.js';
import { createAdapter, getRegisteredTypes } from './channel-adapter.js';
import type { BaseChannelAdapter } from './channel-adapter.js';
// Side-effect import: triggers self-registration of all adapter factories
import './adapters/index.js';
import * as router from './channel-router.js';
import * as engine from './conversation-engine.js';
import * as broker from './permission-broker.js';
import { deliver } from './delivery-layer.js';
import { getBridgeContext } from './context.js';
import { escapeHtml } from './html-utils.js';
import fs from 'node:fs';
import path from 'node:path';
import {
  validateWorkingDirectory,
  validateSessionId,
  isDangerousInput,
  sanitizeInput,
  validateMode,
} from './security/validators.js';

const GLOBAL_KEY = '__bridge_manager__';

// ── Streaming preview helpers ──────────────────────────────────

/** Generate a non-zero random 31-bit integer for use as draft_id. */
function generateDraftId(): number {
  return (Math.floor(Math.random() * 0x7FFFFFFE) + 1); // 1 .. 2^31-1
}

interface StreamConfig {
  intervalMs: number;
  minDeltaChars: number;
  maxChars: number;
}

/** Default stream config per channel type. */
const STREAM_DEFAULTS: Record<string, StreamConfig> = {
  feishu: { intervalMs: 700, minDeltaChars: 20, maxChars: 3900 },
};

function getStreamConfig(channelType = 'feishu'): StreamConfig {
  const { store } = getBridgeContext();
  const defaults = STREAM_DEFAULTS[channelType] || STREAM_DEFAULTS.feishu;
  const prefix = `bridge_${channelType}_stream_`;
  const intervalMs = parseInt(store.getSetting(`${prefix}interval_ms`) || '', 10) || defaults.intervalMs;
  const minDeltaChars = parseInt(store.getSetting(`${prefix}min_delta_chars`) || '', 10) || defaults.minDeltaChars;
  const maxChars = parseInt(store.getSetting(`${prefix}max_chars`) || '', 10) || defaults.maxChars;
  return { intervalMs, minDeltaChars, maxChars };
}

/**
 * Check if a message looks like a numeric permission shortcut (1/2/3) for
 * feishu channels WITH at least one pending permission in that chat.
 *
 * This is used by the adapter loop to route these messages to the inline
 * (non-session-locked) path, avoiding deadlock: the session is blocked
 * waiting for the permission to be resolved, so putting "1" behind the
 * session lock would deadlock.
 */
function isNumericPermissionShortcut(channelType: string, rawText: string, chatId: string): boolean {
  if (channelType !== 'feishu') return false;
  const normalized = rawText.normalize('NFKC').replace(/[\u200B-\u200D\uFEFF]/g, '').trim();
  if (!/^[1234]$/.test(normalized)) return false;
  const { store } = getBridgeContext();
  const pending = store.listPendingPermissionLinksByChat(chatId);
  return pending.length > 0; // any pending → route to inline path
}

/** Fire-and-forget: send a preview draft. Only degrades on permanent failure. */
function flushPreview(
  adapter: BaseChannelAdapter,
  state: StreamingPreviewState,
  config: StreamConfig,
): void {
  if (state.degraded || !adapter.sendPreview) return;

  const text = state.pendingText.length > config.maxChars
    ? state.pendingText.slice(0, config.maxChars) + '...'
    : state.pendingText;

  state.lastSentText = text;
  state.lastSentAt = Date.now();

  adapter.sendPreview(state.chatId, text, state.draftId).then(result => {
    if (result === 'degrade') state.degraded = true;
    // 'skip' — transient failure, next flush will retry naturally
  }).catch(() => {
    // Network error — transient, don't degrade
  });
}

// ── Channel-aware rendering dispatch ──────────────────────────

import type { ChannelAddress, SendResult } from './types.js';

/**
 * Render response text and deliver via the Feishu channel format.
 */
async function deliverResponse(
  adapter: BaseChannelAdapter,
  address: ChannelAddress,
  responseText: string,
  sessionId: string,
  replyToMessageId?: string,
): Promise<SendResult> {
  if (adapter.channelType === 'feishu') {
    // Feishu: pass markdown through for adapter to format as post/card
    return deliver(adapter, {
      address,
      text: responseText,
      parseMode: 'Markdown',
      replyToMessageId,
    }, { sessionId });
  }
  // Generic fallback: deliver as plain text (deliver() handles chunking internally)
  return deliver(adapter, {
    address,
    text: responseText,
    parseMode: 'plain',
    replyToMessageId,
  }, { sessionId });
}

interface AdapterMeta {
  lastMessageAt: string | null;
  lastError: string | null;
}

interface BridgeManagerState {
  adapters: Map<string, BaseChannelAdapter>;
  adapterMeta: Map<string, AdapterMeta>;
  running: boolean;
  startedAt: string | null;
  loopAborts: Map<string, AbortController>;
  activeTasks: Map<string, AbortController>;
  /** Per-session processing chains for concurrency control */
  sessionLocks: Map<string, Promise<void>>;
  autoStartChecked: boolean;
}

export function getState(): BridgeManagerState {
  const g = globalThis as unknown as Record<string, BridgeManagerState>;
  if (!g[GLOBAL_KEY]) {
    g[GLOBAL_KEY] = {
      adapters: new Map(),
      adapterMeta: new Map(),
      running: false,
      startedAt: null,
      loopAborts: new Map(),
      activeTasks: new Map(),
      sessionLocks: new Map(),
      autoStartChecked: false,
    };
  }
  // Backfill sessionLocks for states created before this field existed
  if (!g[GLOBAL_KEY].sessionLocks) {
    g[GLOBAL_KEY].sessionLocks = new Map();
  }
  return g[GLOBAL_KEY];
}

/**
 * Process a function with per-session serialization.
 * Different sessions run concurrently; same-session requests are serialized.
 */
function processWithSessionLock(sessionId: string, fn: () => Promise<void>): Promise<void> {
  const state = getState();
  const prev = state.sessionLocks.get(sessionId) || Promise.resolve();
  const current = prev.then(fn, fn);
  state.sessionLocks.set(sessionId, current);
  // Cleanup when the chain completes.
  // Suppress rejection on the cleanup chain — callers handle errors on `current` directly.
  current.finally(() => {
    if (state.sessionLocks.get(sessionId) === current) {
      state.sessionLocks.delete(sessionId);
    }
  }).catch(() => {});
  return current;
}

/**
 * Start the bridge system.
 * Checks feature flags, registers enabled adapters, starts polling loops.
 */
export async function start(): Promise<void> {
  const state = getState();
  if (state.running) return;

  const { store, lifecycle } = getBridgeContext();

  const bridgeEnabled = store.getSetting('remote_bridge_enabled') === 'true';
  if (!bridgeEnabled) {
    console.log('[bridge-manager] Bridge not enabled (remote_bridge_enabled != true)');
    return;
  }

  // Iterate all registered adapter types and create those that are enabled
  for (const channelType of getRegisteredTypes()) {
    const settingKey = `bridge_${channelType}_enabled`;
    if (store.getSetting(settingKey) !== 'true') continue;

    const adapter = createAdapter(channelType);
    if (!adapter) continue;

    const configError = adapter.validateConfig();
    if (!configError) {
      registerAdapter(adapter);
    } else {
      console.warn(`[bridge-manager] ${channelType} adapter not valid:`, configError);
    }
  }

  // Start all registered adapters, track how many succeeded
  let startedCount = 0;
  for (const [type, adapter] of state.adapters) {
    try {
      await adapter.start();
      console.log(`[bridge-manager] Started adapter: ${type}`);
      startedCount++;
    } catch (err) {
      console.error(`[bridge-manager] Failed to start adapter ${type}:`, err);
    }
  }

  // Only mark as running if at least one adapter started successfully
  if (startedCount === 0) {
    console.warn('[bridge-manager] No adapters started successfully, bridge not activated');
    state.adapters.clear();
    state.adapterMeta.clear();
    return;
  }

  // Mark running BEFORE starting consumer loops — runAdapterLoop checks
  // state.running in its while-condition, so it must be true first.
  state.running = true;
  state.startedAt = new Date().toISOString();

  // Notify host that bridge is starting (e.g., suppress competing polling)
  lifecycle.onBridgeStart?.();

  // Now start the consumer loops (state.running is already true)
  for (const [, adapter] of state.adapters) {
    if (adapter.isRunning()) {
      runAdapterLoop(adapter);
    }
  }

  console.log(`[bridge-manager] Bridge started with ${startedCount} adapter(s)`);

  // Start relay server for multi-bot communication
  startRelayServer();
}

/**
 * Stop the bridge system gracefully.
 */
export async function stop(): Promise<void> {
  const state = getState();
  if (!state.running) return;

  const { lifecycle } = getBridgeContext();

  state.running = false;

  // Abort all event loops
  for (const [, abort] of state.loopAborts) {
    abort.abort();
  }
  state.loopAborts.clear();

  // Stop all adapters
  for (const [type, adapter] of state.adapters) {
    try {
      await adapter.stop();
      console.log(`[bridge-manager] Stopped adapter: ${type}`);
    } catch (err) {
      console.error(`[bridge-manager] Error stopping adapter ${type}:`, err);
    }
  }

  state.adapters.clear();
  state.adapterMeta.clear();
  state.startedAt = null;

  // Notify host that bridge stopped
  lifecycle.onBridgeStop?.();

  // Stop relay server
  stopRelayServer();

  console.log('[bridge-manager] Bridge stopped');
}

/**
 * Lazy auto-start: checks bridge_auto_start setting once and starts if enabled.
 * Called from POST /api/bridge with action 'auto-start' (triggered by Electron on startup).
 */
export function tryAutoStart(): void {
  const state = getState();
  if (state.autoStartChecked) return;
  state.autoStartChecked = true;

  if (state.running) return;

  const { store } = getBridgeContext();
  const autoStart = store.getSetting('bridge_auto_start');
  if (autoStart !== 'true') return;

  start().catch(err => {
    console.error('[bridge-manager] Auto-start failed:', err);
  });
}

/**
 * Get the current bridge status.
 */
export function getStatus(): BridgeStatus {
  const state = getState();
  return {
    running: state.running,
    startedAt: state.startedAt,
    adapters: Array.from(state.adapters.entries()).map(([type, adapter]) => {
      const meta = state.adapterMeta.get(type);
      return {
        channelType: adapter.channelType,
        running: adapter.isRunning(),
        connectedAt: state.startedAt,
        lastMessageAt: meta?.lastMessageAt ?? null,
        error: meta?.lastError ?? null,
      };
    }),
  };
}

/**
 * Register a channel adapter.
 */
export function registerAdapter(adapter: BaseChannelAdapter): void {
  const state = getState();
  state.adapters.set(adapter.channelType, adapter);
}

/**
 * Run the event loop for a single adapter.
 * Messages for different sessions are dispatched concurrently;
 * messages for the same session are serialized via session locks.
 */
function runAdapterLoop(adapter: BaseChannelAdapter): void {
  const state = getState();
  const abort = new AbortController();
  state.loopAborts.set(adapter.channelType, abort);

  (async () => {
    while (state.running && adapter.isRunning()) {
      try {
        const msg = await adapter.consumeOne();
        if (!msg) continue; // Adapter stopped

        // Callback queries, commands, and numeric permission shortcuts are
        // lightweight — process inline (outside session lock).
        // Regular messages use per-session locking for concurrency.
        //
        // IMPORTANT: numeric shortcuts (1/2/3) for feishu/qq MUST run outside
        // the session lock. The current session is blocked waiting for the
        // permission to be resolved; if "1" enters the session lock queue it
        // deadlocks (permission waits for "1", "1" waits for lock release).
        if (
          msg.callbackData ||
          msg.text.trim().startsWith('/') ||
          isNumericPermissionShortcut(adapter.channelType, msg.text.trim(), msg.address.chatId)
        ) {
          await handleMessage(adapter, msg);
        } else {
          const binding = router.resolve(msg.address);
          // Fire-and-forget into session lock — loop continues to accept
          // messages for other sessions immediately.
          processWithSessionLock(binding.codepilotSessionId, () =>
            handleMessage(adapter, msg),
          ).catch(err => {
            console.error(`[bridge-manager] Session ${binding.codepilotSessionId.slice(0, 8)} error:`, err);
          });
        }
      } catch (err) {
        if (abort.signal.aborted) break;
        const errMsg = err instanceof Error ? err.message : String(err);
        console.error(`[bridge-manager] Error in ${adapter.channelType} loop:`, err);
        // Track last error per adapter
        const meta = state.adapterMeta.get(adapter.channelType) || { lastMessageAt: null, lastError: null };
        meta.lastError = errMsg;
        state.adapterMeta.set(adapter.channelType, meta);
        // Brief delay to prevent tight error loops
        await new Promise(r => setTimeout(r, 1000));
      }
    }
  })().catch(err => {
    if (!abort.signal.aborted) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error(`[bridge-manager] ${adapter.channelType} loop crashed:`, err);
      const meta = state.adapterMeta.get(adapter.channelType) || { lastMessageAt: null, lastError: null };
      meta.lastError = errMsg;
      state.adapterMeta.set(adapter.channelType, meta);
    }
  });
}

/**
 * Handle a single inbound message.
 */
async function handleMessage(
  adapter: BaseChannelAdapter,
  msg: InboundMessage,
): Promise<void> {
  const { store } = getBridgeContext();

  // Update lastMessageAt for this adapter
  const adapterState = getState();
  const meta = adapterState.adapterMeta.get(adapter.channelType) || { lastMessageAt: null, lastError: null };
  meta.lastMessageAt = new Date().toISOString();
  adapterState.adapterMeta.set(adapter.channelType, meta);

  // Acknowledge the update offset after processing completes (or fails).
  // This ensures the adapter only advances its committed offset once the
  // message has been fully handled, preventing message loss on crash.
  const ack = () => {
    if (msg.updateId != null && adapter.acknowledgeUpdate) {
      adapter.acknowledgeUpdate(msg.updateId);
    }
  };

  // Handle callback queries (permission buttons + form submissions)
  if (msg.callbackData) {
    // AskUserQuestion form submission: ask:submit:<questionId>
    if (msg.callbackData.startsWith('ask:submit:') && msg.formValue) {
      const questionId = msg.callbackData.slice('ask:submit:'.length);
      const { permissions, store } = getBridgeContext();

      // Look up the stored question metadata
      const link = store.getPermissionLink(questionId);
      let questions: Array<{ question: string; options?: Array<{ label: string; description?: string }>; multiSelect?: boolean }> = [];
      if (link?.suggestions) {
        try {
          const parsed = JSON.parse(link.suggestions);
          if (parsed.questions) {
            questions = parsed.questions;
          } else if (parsed.questionText && parsed.options) {
            // Legacy format from numeric shortcut fallback
            questions = [{ question: parsed.questionText, options: parsed.options.map((l: string) => ({ label: l })) }];
          }
        } catch { /* ignore */ }
      }

      // Parse form values into answers
      console.log(`[bridge-manager] AskUserQuestion formValue=${JSON.stringify(msg.formValue)}, questions count=${questions.length}, link.suggestions=${link?.suggestions?.slice(0, 200)}`);
      const answers: Record<string, string> = {};
      for (let i = 0; i < questions.length; i++) {
        const q = questions[i];
        const rawValue = msg.formValue[`q_${i}`];
        if (rawValue === undefined || rawValue === null) continue;

        // Check if user typed a custom answer (takes priority over dropdown)
        const customKey = `q_${i}_custom`;
        const customValue = msg.formValue[customKey];
        if (typeof customValue === 'string' && customValue.trim()) {
          answers[q.question] = customValue.trim();
          continue;
        }

        if (q.multiSelect && Array.isArray(rawValue)) {
          // Multi-select: values are "opt_N_label", extract labels
          const labels = rawValue.map((v: string) => v.replace(/^opt_\d+_/, ''));
          answers[q.question] = labels.join(', ');
        } else if (typeof rawValue === 'string') {
          if (rawValue.startsWith('opt_')) {
            // Single-select: "opt_N_label"
            answers[q.question] = rawValue.replace(/^opt_\d+_/, '');
          } else {
            // Free-text input
            answers[q.question] = rawValue;
          }
        }
      }

      console.log(`[bridge-manager] AskUserQuestion form submitted: questionId=${questionId}, answers=${JSON.stringify(answers)}`);

      const resolved = permissions.resolvePendingPermission(questionId, {
        behavior: 'allow',
        updatedInput: { answers },
      });

      console.log(`[bridge-manager] AskUserQuestion resolved=${resolved}, link=${link ? `messageId=${link.messageId}` : 'null'}, hasPatch=${typeof (adapter as any).patchCardMessage}`);

      if (resolved) {
        try { store.markPermissionLinkResolved(questionId); } catch { /* best effort */ }
        // Update original card to "answered" (collapsed) state
        if (link?.messageId && adapter.patchCardMessage) {
          try {
            const { buildAskUserAnsweredCard } = await import('./markdown/feishu.js');
            const answeredCardJson = buildAskUserAnsweredCard(questions, answers);
            await adapter.patchCardMessage(link.messageId, answeredCardJson);
          } catch (err) {
            console.warn('[bridge-manager] Failed to update AskUserQuestion card:', err instanceof Error ? err.message : err);
          }
        }
      }

      ack();
      return;
    }

    // Resume session picker: resume:<bindingId>
    if (msg.callbackData.startsWith('resume:')) {
      const bindingId = msg.callbackData.slice('resume:'.length);
      const { store } = getBridgeContext();
      const bindings = router.listBindings(adapter.channelType);
      const target = bindings.find(b => b.id === bindingId);
      if (target) {
        // Abort any running task on the current session
        const oldBinding = router.resolve(msg.address);
        const st = getState();
        const oldTask = st.activeTasks.get(oldBinding.codepilotSessionId);
        if (oldTask) {
          oldTask.abort();
          st.activeTasks.delete(oldBinding.codepilotSessionId);
        }
        // Bind this chat to the selected session
        router.bindToSession(msg.address, target.codepilotSessionId);
        await deliver(adapter, {
          address: msg.address,
          text: `Resumed session \`${target.codepilotSessionId.slice(0, 8)}...\` (${escapeHtml(target.workingDirectory || '~')})`,
          parseMode: 'plain',
        });
        // Update the card to show selection result
        if (msg.callbackMessageId && adapter.patchCardMessage) {
          try {
            const confirmedCard = JSON.stringify({
              schema: '2.0',
              config: { wide_screen_mode: true },
              header: {
                title: { tag: 'plain_text', content: 'Session Resumed' },
                template: 'green',
                icon: { tag: 'standard_icon', token: 'check-circle_outlined' },
              },
              body: { elements: [{ tag: 'markdown', content: `✅ \`${target.codepilotSessionId.slice(0, 8)}...\` · **${escapeHtml(target.workingDirectory || '~')}**`, text_size: 'normal' }] },
            });
            await adapter.patchCardMessage(msg.callbackMessageId, confirmedCard);
          } catch { /* best effort */ }
        }
      } else {
        await deliver(adapter, {
          address: msg.address,
          text: 'Session not found.',
          parseMode: 'plain',
        });
      }
      ack();
      return;
    }

    const handled = broker.handlePermissionCallback(msg.callbackData, msg.address.chatId, msg.callbackMessageId);
    if (handled) {
      // Collapse the permission card to a resolved state
      const permMessageId = msg.callbackMessageId;
      if (permMessageId && adapter.patchCardMessage) {
        try {
          const action = msg.callbackData.split(':')[1] || 'allow';
          const actionLabel = action === 'deny' ? 'Denied' : action === 'allow_session' ? 'Allowed (session)' : 'Allowed';
          const template = action === 'deny' ? 'red' : 'green';
          const icon = action === 'deny' ? 'close-circle_outlined' : 'check-circle_outlined';
          const collapsedCard = JSON.stringify({
            schema: '2.0',
            config: { wide_screen_mode: true },
            header: {
              title: { tag: 'plain_text', content: `Permission ${actionLabel}` },
              template,
              icon: { tag: 'standard_icon', token: icon },
            },
            body: { elements: [{
              tag: 'collapsible_panel',
              expanded: false,
              header: { title: { tag: 'plain_text', content: `✅ ${actionLabel}` } },
              border: { color: template },
              vertical_spacing: '8px',
              elements: [{ tag: 'markdown', content: `Permission response: **${actionLabel}**`, text_size: 'normal' }],
            }] },
          });
          await adapter.patchCardMessage(permMessageId, collapsedCard);
        } catch { /* best effort */ }
      }
    }
    ack();
    return;
  }

  const rawText = msg.text.trim();
  const hasAttachments = msg.attachments && msg.attachments.length > 0;

  // Handle attachment-only download failures — surface error to user instead of silently dropping
  if (!rawText && !hasAttachments) {
    const rawData = msg.raw as {
      imageDownloadFailed?: boolean;
      attachmentDownloadFailed?: boolean;
      failedCount?: number;
      failedLabel?: string;
      userVisibleError?: string;
    } | undefined;
    if (rawData?.userVisibleError) {
      await deliver(adapter, {
        address: msg.address,
        text: rawData.userVisibleError,
        parseMode: 'plain',
        replyToMessageId: msg.messageId,
      });
    } else if (rawData?.imageDownloadFailed || rawData?.attachmentDownloadFailed) {
      const failureLabel = rawData.failedLabel || (rawData.imageDownloadFailed ? 'image(s)' : 'attachment(s)');
      await deliver(adapter, {
        address: msg.address,
        text: `Failed to download ${rawData.failedCount ?? 1} ${failureLabel}. Please try sending again.`,
        parseMode: 'plain',
        replyToMessageId: msg.messageId,
      });
    }
    ack();
    return;
  }

  // ── Numeric shortcut for permission replies (feishu only) ──
  // On mobile, typing `/perm allow <uuid>` is painful.
  // If the user sends "1", "2", or "3" and there is exactly one pending
  // permission for this chat, map it: 1→allow, 2→allow_session, 3→deny.
  //
  // Input normalization: mobile keyboards / IM clients may send fullwidth
  // digits (１２３), digits with zero-width joiners, or other Unicode
  // variants. NFKC normalization folds them all to ASCII 1/2/3.
  if (adapter.channelType === 'feishu') {
    // eslint-disable-next-line no-control-regex
    const normalized = rawText.normalize('NFKC').replace(/[\u200B-\u200D\uFEFF]/g, '').trim();
    if (/^[1234]$/.test(normalized)) {
      const pendingLinks = store.listPendingPermissionLinksByChat(msg.address.chatId);
      if (pendingLinks.length >= 1) {
        // Use the most recent pending link; auto-resolve older stale ones
        const link = pendingLinks[pendingLinks.length - 1];
        if (pendingLinks.length > 1) {
          for (let i = 0; i < pendingLinks.length - 1; i++) {
            try { store.markPermissionLinkResolved(pendingLinks[i].permissionRequestId); } catch { /* best effort */ }
          }
        }
        const idx = parseInt(normalized, 10);

        // Check if this is an AskUserQuestion
        let isAskQuestion = false;
        let askData: { questionText: string; options: string[] } | null = null;
        if (link.suggestions) {
          try {
            const parsed = JSON.parse(link.suggestions);
            if (parsed && typeof parsed === 'object' && 'questionText' in parsed && 'options' in parsed) {
              isAskQuestion = true;
              askData = parsed as { questionText: string; options: string[] };
            }
          } catch { /* not AskUserQuestion */ }
        }

        if (isAskQuestion && askData && idx - 1 < askData.options.length) {
          const selectedLabel = askData.options[idx - 1];
          const { permissions } = getBridgeContext();
          const resolved = permissions.resolvePendingPermission(link.permissionRequestId, {
            behavior: 'allow',
            updatedInput: { answers: { [askData.questionText]: selectedLabel } },
          });
          if (resolved) {
            // Edit the original question message to show selection result
            if (adapter.editMessage && link.messageId) {
              adapter.editMessage(link.messageId, `✅ ${askData.questionText} → ${selectedLabel}`).catch(() => {});
            }
            try { store.markPermissionLinkResolved(link.permissionRequestId); } catch { /* best effort */ }
          }
          ack();
          return;
        }

        // Regular permission shortcut (1=allow, 2=allow_session, 3=deny)
        if (/^[123]$/.test(normalized) && !isAskQuestion) {
          const actionMap: Record<string, string> = { '1': 'allow', '2': 'allow_session', '3': 'deny' };
          const action = actionMap[normalized];
          const permId = link.permissionRequestId;
          const callbackData = `perm:${action}:${permId}`;
          const handled = broker.handlePermissionCallback(callbackData, msg.address.chatId);
          const label = normalized === '1' ? 'Allow' : normalized === '2' ? 'Allow Session' : 'Deny';
          if (handled) {
            await deliver(adapter, {
              address: msg.address,
              text: `${label}: recorded.`,
              parseMode: 'plain',
              replyToMessageId: msg.messageId,
            });
          } else {
            await deliver(adapter, {
              address: msg.address,
              text: `Permission not found or already resolved.`,
              parseMode: 'plain',
              replyToMessageId: msg.messageId,
            });
          }
          ack();
          return;
        }
      }
      // pendingLinks.length === 0: no pending permissions, fall through as normal message
    } else if (rawText !== normalized && /^[123]$/.test(rawText) === false) {
      // Log when normalization changed the text — helps diagnose encoding issues
      const codePoints = [...rawText].map(c => 'U+' + c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0'));
      console.log(`[bridge-manager] Shortcut candidate raw codepoints: ${codePoints.join(' ')} → normalized: "${normalized}"`);
    }
  }

  // Context-only messages: skip processing entirely (check before command dispatch)
  if (msg.contextOnly) {
    console.log(`[bridge-manager] contextOnly FILTERED: msgId=${msg.messageId} chatId=${msg.address.chatId} text=${JSON.stringify(msg.text?.slice(0, 100))}`);
    ack();
    return;
  }

  // Check for IM commands (before sanitization — commands are validated individually)
  if (rawText.startsWith('/')) {
    await handleCommand(adapter, msg, rawText);
    ack();
    return;
  }

  // Sanitize general message text before routing to conversation engine
  const { text, truncated } = sanitizeInput(rawText);
  if (truncated) {
    console.warn(`[bridge-manager] Input truncated from ${rawText.length} to ${text.length} chars for chat ${msg.address.chatId}`);
    store.insertAuditLog({
      channelType: adapter.channelType,
      chatId: msg.address.chatId,
      direction: 'inbound',
      messageId: msg.messageId,
      summary: `[TRUNCATED] Input truncated from ${rawText.length} chars`,
    });
  }

  if (!text && !hasAttachments) { ack(); return; }

  await processRegularMessage(adapter, msg, text, hasAttachments);
}

/**
 * Process a regular (non-command) message through the conversation engine.
 * Extracted so it can be called from both handleMessage and forwardToAI.
 */
async function processRegularMessage(
  adapter: BaseChannelAdapter,
  msg: InboundMessage,
  text: string,
  hasAttachments?: boolean,
): Promise<void> {
  const { store } = getBridgeContext();

  // Thread session isolation: use composite key for topic groups
  const threadSessionEnabled = store.getSetting('bridge_feishu_thread_session') === 'true';
  if (threadSessionEnabled && msg.threadId && msg.isGroup && msg.groupChatMode === 'topic') {
    msg.address = { ...msg.address, chatId: `${msg.address.chatId}:thread:${msg.threadId}` };
  }

  // Regular message — route to conversation engine
  const binding = router.resolve(msg.address);

  // Notify adapter that message processing is starting (e.g., typing indicator)
  adapter.onMessageStart?.(msg.address.chatId);

  // Create an AbortController so /stop can cancel this task externally
  const taskAbort = new AbortController();
  const state = getState();
  state.activeTasks.set(binding.codepilotSessionId, taskAbort);

  // ── Streaming preview setup ──────────────────────────────────
  let previewState: StreamingPreviewState | null = null;
  const caps = adapter.getPreviewCapabilities?.(msg.address.chatId) ?? null;
  if (caps?.supported) {
    previewState = {
      draftId: generateDraftId(),
      chatId: msg.address.chatId,
      lastSentText: '',
      lastSentAt: 0,
      degraded: false,
      throttleTimer: null,
      pendingText: '',
    };
  }

  const streamCfg = previewState ? getStreamConfig(adapter.channelType) : null;

  // Build the preview onPartialText callback (or undefined if preview not supported)
  const previewOnPartialText = (previewState && streamCfg) ? (fullText: string) => {
    const ps = previewState!;
    const cfg = streamCfg!;
    if (ps.degraded) return;

    // Truncate to maxChars + ellipsis
    ps.pendingText = fullText.length > cfg.maxChars
      ? fullText.slice(0, cfg.maxChars) + '...'
      : fullText;

    const delta = ps.pendingText.length - ps.lastSentText.length;
    const elapsed = Date.now() - ps.lastSentAt;

    if (delta < cfg.minDeltaChars && ps.lastSentAt > 0) {
      // Not enough new content — schedule trailing-edge timer if not already set
      if (!ps.throttleTimer) {
        ps.throttleTimer = setTimeout(() => {
          ps.throttleTimer = null;
          if (!ps.degraded) flushPreview(adapter, ps, cfg);
        }, cfg.intervalMs);
      }
      return;
    }

    if (elapsed < cfg.intervalMs && ps.lastSentAt > 0) {
      // Too soon — schedule trailing-edge timer to ensure latest text is sent
      if (!ps.throttleTimer) {
        ps.throttleTimer = setTimeout(() => {
          ps.throttleTimer = null;
          if (!ps.degraded) flushPreview(adapter, ps, cfg);
        }, cfg.intervalMs - elapsed);
      }
      return;
    }

    // Clear any pending trailing-edge timer and flush immediately
    if (ps.throttleTimer) {
      clearTimeout(ps.throttleTimer);
      ps.throttleTimer = null;
    }
    flushPreview(adapter, ps, cfg);
  } : undefined;

  // ── Streaming card setup (Feishu CardKit v2) ──────────────────
  // If the adapter supports streaming cards (e.g. Feishu), wire up
  // onStreamText, onToolEvent, and onStreamEnd callbacks.
  // These run in parallel with the existing preview system — Feishu
  // uses cards instead of message edit for streaming.
  const hasStreamingCards = typeof adapter.onStreamText === 'function';
  const toolCallTracker = new Map<string, ToolCallInfo>();

  const onStreamCardText = hasStreamingCards ? (fullText: string) => {
    try { adapter.onStreamText!(msg.address.chatId, fullText); } catch { /* non-critical */ }
  } : undefined;

  const onToolEvent = hasStreamingCards ? (toolId: string, toolName: string, status: 'running' | 'complete' | 'error') => {
    if (toolName) {
      const existing = toolCallTracker.get(toolId);
      toolCallTracker.set(toolId, {
        id: toolId,
        name: toolName,
        status,
        startedAt: existing?.startedAt ?? (status === 'running' ? Date.now() : undefined),
      });
    } else {
      // tool_result doesn't carry name — update existing entry's status
      const existing = toolCallTracker.get(toolId);
      if (existing) existing.status = status;
    }
    try {
      adapter.onToolEvent!(msg.address.chatId, Array.from(toolCallTracker.values()));
    } catch { /* non-critical */ }
  } : undefined;

  // Combined partial text callback: streaming preview + streaming cards
  const onPartialText = (previewOnPartialText || onStreamCardText) ? (fullText: string) => {
    if (previewOnPartialText) previewOnPartialText(fullText);
    if (onStreamCardText) onStreamCardText(fullText);
  } : undefined;

  try {
    // Pass permission callback so requests are forwarded to IM immediately
    // during streaming (the stream blocks until permission is resolved).
    // Use text or empty string for image-only messages (prompt is still required by streamClaude)
    let promptText = text || (hasAttachments ? '请分析这个文件的内容。' : '');

    // Chat environment context — injected as system prompt (not user message)
    // to avoid being treated as prompt injection by the AI safety layer.
    const senderLabel = msg.senderName || msg.address.displayName || '用户';
    let chatContext: string;
    if (msg.isGroup) {
      const multiBotEnabled = store.getSetting('bridge_feishu_multi_bot_enabled') === 'true';
      // Bot sender label stays in user message (it's message metadata)
      if (multiBotEnabled && msg.senderType === 'bot' && msg.senderName) {
        promptText = `[来自机器人: ${msg.senderName}]\n${promptText}`;
      }
      const groupLabel = msg.groupName ? `「${msg.groupName}」` : '';
      const myBotName = adapter.botName || '';
      const myBotLabel = myBotName ? `你在飞书中的机器人名字是「${myBotName}」。` : '';
      chatContext = `[群聊环境] 这是飞书群聊${groupLabel}。${myBotLabel}发送者: ${senderLabel}。`;
      if (multiBotEnabled) {
        const peerNames = msg.groupBotNames && msg.groupBotNames.length > 0
          ? msg.groupBotNames
          : getRelayPeerNames();
        const peerList = peerNames.length > 0 ? `群里的其他机器人: ${peerNames.join(', ')}。` : '';
        if (peerNames.length > 0) {
          chatContext += peerList
            + `重要：其他机器人不会自动看到你的回复。如果你需要某个机器人回应你，必须在回复中写 @机器人名（如 @${peerNames[0]}）来触发对方，否则对方不会收到你的消息。`;
        }
        // When replying to a bot message, remind to @ the sender specifically
        if (msg.senderType === 'bot' && msg.senderName) {
          chatContext += `\n\n当前消息来自机器人「${msg.senderName}」。你的回复必须包含 @${msg.senderName} 否则对方收不到。`;
        }
      }
      // Per-group system prompt from config
      const groupConfig = getGroupConfig(store);
      if (groupConfig) {
        const originalChatId = msg.address.chatId.split(':thread:')[0];
        const chatConfig = groupConfig[originalChatId] || groupConfig[msg.address.chatId];
        if (chatConfig?.systemPrompt) {
          chatContext += `\n\n${chatConfig.systemPrompt}`;
        }
      }
    } else {
      chatContext = `[私聊环境] 这是与${senderLabel}的一对一私聊。`;
    }

    const result = await engine.processMessage(binding, promptText, async (perm) => {
      // ExitPlanMode: send plan content before the permission card
      // so the user can read the plan before deciding to approve.
      if (perm.toolName === 'ExitPlanMode' && binding.workingDirectory) {
        try {
          const plansDir = path.join(binding.workingDirectory, '.claude', 'plans');
          const files = fs.readdirSync(plansDir)
            .filter((f: string) => f.endsWith('.md'))
            .map((f: string) => ({ name: f, mtime: fs.statSync(path.join(plansDir, f)).mtimeMs }))
            .sort((a: { mtime: number }, b: { mtime: number }) => b.mtime - a.mtime);
          if (files.length > 0) {
            const content = fs.readFileSync(path.join(plansDir, files[0].name), 'utf-8').trim();
            if (content) {
              await deliver(adapter, {
                address: msg.address,
                text: `**Plan**\n\n${content}`,
                parseMode: 'plain',
                replyToMessageId: msg.messageId,
              });
            }
          }
        } catch (err) {
          console.warn('[bridge-manager] Failed to read plan preview:', err);
        }
      }

      await broker.forwardPermissionRequest(
        adapter,
        msg.address,
        perm.permissionRequestId,
        perm.toolName,
        perm.toolInput,
        binding.codepilotSessionId,
        perm.suggestions,
        msg.messageId,
      );
    }, taskAbort.signal, hasAttachments ? msg.attachments : undefined, onPartialText, onToolEvent,
    // onAskUserQuestion — forward to IM with interactive form card
    async (question) => {
      const { permissions } = getBridgeContext();
      try {
        const input = question.toolInput as {
          questions?: Array<{
            question: string;
            options?: Array<{ label: string; description?: string }>;
            multiSelect?: boolean;
          }>;
        };
        const questions = input.questions || [];
        if (questions.length === 0) return;

        // Build and send interactive form card
        const { buildAskUserQuestionCard } = await import('./markdown/feishu.js');
        const cardJson = buildAskUserQuestionCard(question.questionId, questions);

        const outMsg: OutboundMessage = {
          address: msg.address,
          text: '',
          cardJson,
          replyToMessageId: msg.messageId,
        };

        const result = await deliver(adapter, outMsg, { sessionId: binding.codepilotSessionId });

        if (result.ok && result.messageId) {
          try {
            const { store } = getBridgeContext();
            // Store question metadata for form submit handling
            store.insertPermissionLink({
              permissionRequestId: question.questionId,
              channelType: adapter.channelType,
              chatId: msg.address.chatId,
              messageId: result.messageId,
              toolName: 'AskUserQuestion',
              suggestions: JSON.stringify({ questions }),
            });
          } catch { /* best effort */ }
        }

        // Also send a plain-text fallback hint for numeric shortcuts
        if (questions.length === 1 && questions[0].options && questions[0].options.length > 0) {
          const q = questions[0];
          const lines = q.options!.map((opt, i) => `${i + 1}. ${opt.label}`);
          const fallbackMsg: OutboundMessage = {
            address: msg.address,
            text: `💡 也可以直接回复数字：\n${lines.join('\n')}`,
            parseMode: 'plain',
          };
          const fallbackResult = await deliver(adapter, fallbackMsg, { sessionId: binding.codepilotSessionId });
          // Link the fallback message for numeric shortcut resolution (use separate ID to avoid overwriting form link)
          if (fallbackResult.ok && fallbackResult.messageId) {
            try {
              const { store } = getBridgeContext();
              store.insertPermissionLink({
                permissionRequestId: `${question.questionId}_fallback`,
                channelType: adapter.channelType,
                chatId: msg.address.chatId,
                messageId: fallbackResult.messageId,
                toolName: 'AskUserQuestion',
                suggestions: JSON.stringify({ questionText: q.question, options: q.options!.map(o => o.label) }),
              });
            } catch { /* best effort */ }
          }
        }
      } catch (err) {
        console.error('[bridge-manager] Failed to forward AskUserQuestion:', err);
        permissions.resolvePendingPermission(question.questionId, {
          behavior: 'deny',
          message: 'Failed to forward question to IM',
        });
      }
    }, chatContext);

    // Finalize streaming card if adapter supports it.
    // onStreamEnd awaits any in-flight card creation and returns true if a card
    // was actually finalized (meaning content is already visible to the user).
    let cardFinalized = false;
    if (hasStreamingCards && adapter.onStreamEnd) {
      const meta = {
        tokenUsage: result.tokenUsage ? {
          input: result.tokenUsage.input_tokens ?? 0,
          output: result.tokenUsage.output_tokens ?? 0,
          cacheRead: result.tokenUsage.cache_read_input_tokens ?? undefined,
          cacheCreation: result.tokenUsage.cache_creation_input_tokens ?? undefined,
        } : undefined,
        model: result.model || undefined,
      };
      try {
        const status = result.hasError ? 'error' : 'completed';
        cardFinalized = await adapter.onStreamEnd(msg.address.chatId, status, result.responseText, meta);
      } catch (err) {
        console.warn('[bridge-manager] Card finalize failed:', err instanceof Error ? err.message : err);
      }
    }

    // Send response text — render via channel-appropriate format.
    // Skip if streaming card was finalized (content already in card).
    if (result.responseText) {
      if (!cardFinalized) {
        await deliverResponse(adapter, msg.address, result.responseText, binding.codepilotSessionId, msg.messageId);
      }
    } else if (result.hasError) {
      const errorResponse: OutboundMessage = {
        address: msg.address,
        text: `<b>Error:</b> ${escapeHtml(result.errorMessage)}`,
        parseMode: 'HTML',
        replyToMessageId: msg.messageId,
      };
      await deliver(adapter, errorResponse);
    }

    // Persist the actual SDK session ID for future resume.
    // If the result has an error and no session ID was captured, clear the
    // stale ID so the next message starts fresh instead of retrying a broken resume.
    if (binding.id) {
      try {
        const update = computeSdkSessionUpdate(result.sdkSessionId, result.hasError, result.errorMessage);
        if (update !== null) {
          store.updateChannelBinding(binding.id, { sdkSessionId: update });
        }
      } catch { /* best effort */ }
    }
  } finally {
    // Clean up preview state
    if (previewState) {
      if (previewState.throttleTimer) {
        clearTimeout(previewState.throttleTimer);
        previewState.throttleTimer = null;
      }
      adapter.endPreview?.(msg.address.chatId, previewState.draftId);
    }

    // If task was aborted and streaming card is still active, finalize as interrupted
    if (hasStreamingCards && adapter.onStreamEnd && taskAbort.signal.aborted) {
      try {
        await adapter.onStreamEnd(msg.address.chatId, 'interrupted', '');
      } catch { /* best effort */ }
    }

    state.activeTasks.delete(binding.codepilotSessionId);
    // Notify adapter that message processing ended
    adapter.onMessageEnd?.(msg.address.chatId);
  }
}

/**
 * Forward a slash command to the AI CLI as a regular message.
 * Acquires session lock and processes through the conversation engine.
 */
async function forwardToAI(
  adapter: BaseChannelAdapter,
  msg: InboundMessage,
  promptText: string,
): Promise<void> {
  const binding = router.resolve(msg.address);
  await processWithSessionLock(binding.codepilotSessionId, () =>
    processRegularMessage(adapter, msg, promptText),
  );
}

/** Commands that forward their args to the AI CLI. */
const FORWARD_COMMANDS = new Set(['/ask', '/run', '/code']);

/** Cached parsed group config (avoids JSON.parse on every group message). */
let _groupConfigRaw: string | null = null;
let _groupConfigParsed: Record<string, any> | null = null;
function getGroupConfig(store: { getSetting(key: string): string | null }): Record<string, any> | null {
  const raw = store.getSetting('bridge_feishu_group_config');
  if (!raw) return null;
  if (raw === _groupConfigRaw) return _groupConfigParsed;
  try {
    _groupConfigParsed = JSON.parse(raw);
    _groupConfigRaw = raw;
  } catch {
    _groupConfigParsed = null;
    _groupConfigRaw = raw;
  }
  return _groupConfigParsed;
}

/**
 * Handle IM slash commands.
 */
async function handleCommand(
  adapter: BaseChannelAdapter,
  msg: InboundMessage,
  text: string,
): Promise<void> {
  const { store } = getBridgeContext();

  // Extract command and args (handle /command@botname format)
  const parts = text.split(/\s+/);
  const command = parts[0].split('@')[0].toLowerCase();
  const args = parts.slice(1).join(' ').trim();

  // Run dangerous-input detection on the full command text
  const dangerCheck = isDangerousInput(text);
  if (dangerCheck.dangerous) {
    store.insertAuditLog({
      channelType: adapter.channelType,
      chatId: msg.address.chatId,
      direction: 'inbound',
      messageId: msg.messageId,
      summary: `[BLOCKED] Dangerous input detected: ${dangerCheck.reason}`,
    });
    console.warn(`[bridge-manager] Blocked dangerous command input from chat ${msg.address.chatId}: ${dangerCheck.reason}`);
    await deliver(adapter, {
      address: msg.address,
      text: `Command rejected: invalid input detected.`,
      parseMode: 'plain',
      replyToMessageId: msg.messageId,
    });
    return;
  }

  // ── Forward commands to AI CLI ──
  if (FORWARD_COMMANDS.has(command)) {
    if (!args) {
      await deliver(adapter, {
        address: msg.address,
        text: `Usage: ${command} <your message>`,
        parseMode: 'plain',
        replyToMessageId: msg.messageId,
      });
      return;
    }
    await forwardToAI(adapter, msg, args);
    return;
  }

  let response = '';

  switch (command) {
    case '/start':
      response = [
        '<b>CodePilot Bridge</b>',
        '',
        'Send any message to interact with Claude.',
        '',
        '<b>Commands:</b>',
        '/ask &lt;message&gt; - Ask AI a question',
        '/run &lt;description&gt; - Ask AI to run a command',
        '/code &lt;task&gt; - Ask AI to write code',
        '/new [path] - Start new session',
        '/bind &lt;session_id&gt; - Bind to existing session',
        '/cwd /path - Change working directory',
        '/mode plan|code|ask - Change mode',
        '/model &lt;name&gt; - Switch model (e.g. sonnet, opus)',
        '/status - Show current status',
        '/sessions - List recent sessions',
        '/resume [n] - Resume a previous session',
        '/stop - Stop current session',
        '/perm allow|allow_session|deny &lt;id&gt; - Respond to permission',
        '/help - Show this help',
      ].join('\n');
      break;

    case '/new': {
      // Abort any running task on the current session before creating a new one
      const oldBinding = router.resolve(msg.address);
      const st = getState();
      const oldTask = st.activeTasks.get(oldBinding.codepilotSessionId);
      if (oldTask) {
        oldTask.abort();
        st.activeTasks.delete(oldBinding.codepilotSessionId);
      }

      let workDir: string | undefined;
      if (args) {
        const validated = validateWorkingDirectory(args);
        if (!validated) {
          response = 'Invalid path. Must be an absolute path without traversal sequences.';
          break;
        }
        workDir = validated;
      }
      const binding = router.createBinding(msg.address, workDir);
      response = `New session created.\nSession: <code>${binding.codepilotSessionId.slice(0, 8)}...</code>\nCWD: <code>${escapeHtml(binding.workingDirectory || '~')}</code>`;
      break;
    }

    case '/bind': {
      if (!args) {
        response = 'Usage: /bind &lt;session_id&gt;';
        break;
      }
      if (!validateSessionId(args)) {
        response = 'Invalid session ID format. Expected a 32-64 character hex/UUID string.';
        break;
      }
      const binding = router.bindToSession(msg.address, args);
      if (binding) {
        response = `Bound to session <code>${args.slice(0, 8)}...</code>`;
      } else {
        response = 'Session not found.';
      }
      break;
    }

    case '/cwd': {
      if (!args) {
        const binding = router.resolve(msg.address);
        response = `Current working directory: <code>${escapeHtml(binding.workingDirectory)}</code>`;
        break;
      }
      const validatedPath = validateWorkingDirectory(args);
      if (!validatedPath) {
        response = 'Invalid path. Must be an absolute path without traversal sequences or special characters.';
        break;
      }
      const binding = router.resolve(msg.address);
      // Clear sdkSessionId so the next message starts a fresh CLI session
      // in the new directory instead of trying to resume the old one.
      router.updateBinding(binding.id, { workingDirectory: validatedPath, sdkSessionId: '' });
      response = `Working directory set to <code>${escapeHtml(validatedPath)}</code>`;
      break;
    }

    case '/mode': {
      if (!validateMode(args)) {
        response = 'Usage: /mode plan|code|ask';
        break;
      }
      const binding = router.resolve(msg.address);
      router.updateBinding(binding.id, { mode: args });
      response = `Mode set to <b>${args}</b>`;
      break;
    }

    case '/model': {
      const binding = router.resolve(msg.address);
      if (!args) {
        const rt = getBridgeContext().runtime;
        // Resolve actual model: binding override > runtime default config
        let actualModel = binding.model || '';
        if (!actualModel && rt === 'codex') {
          try {
            const tomlPath = require('path').join(require('os').homedir(), '.codex', 'config.toml');
            const toml = require('fs').readFileSync(tomlPath, 'utf-8');
            const match = toml.match(/^\s*model\s*=\s*"([^"]+)"/m);
            if (match) actualModel = match[1];
          } catch { /* ignore */ }
        }
        const lines = [`Current model: <code>${actualModel || 'default'}</code>`];
        lines.push(`Usage: /model &lt;name&gt; · /model default to reset.`);
        response = lines.join('\n');
        break;
      }
      const modelName = args.toLowerCase() === 'default' ? '' : args.trim();
      // Claude Code supports resuming a session with a different model,
      // so we keep sdkSessionId intact. Codex does not — clear it to force a new thread.
      const rt2 = getBridgeContext().runtime;
      const needsNewSession = rt2 === 'codex';
      const updates: Partial<ChannelBinding> = { model: modelName };
      if (needsNewSession) {
        updates.sdkSessionId = '';
      }
      router.updateBinding(binding.id, updates);
      const suffix = needsNewSession ? ' Next message will use a new session.' : ' Session preserved.';
      response = modelName
        ? `Model set to <code>${escapeHtml(modelName)}</code>.${suffix}`
        : `Model reset to <b>default</b>.${suffix}`;
      break;
    }

    case '/status': {
      const binding = router.resolve(msg.address);
      response = [
        '<b>Bridge Status</b>',
        '',
        `Session: <code>${binding.codepilotSessionId.slice(0, 8)}...</code>`,
        `CWD: <code>${escapeHtml(binding.workingDirectory || '~')}</code>`,
        `Mode: <b>${binding.mode}</b>`,
        `Model: <code>${binding.model || 'default'}</code>`,
      ].join('\n');
      break;
    }

    case '/sessions': {
      const bindings = router.listBindings(adapter.channelType);
      if (bindings.length === 0) {
        response = 'No sessions found.';
      } else {
        const lines = ['<b>Sessions:</b>', ''];
        for (const b of bindings.slice(0, 10)) {
          const active = b.active ? 'active' : 'inactive';
          lines.push(`<code>${b.codepilotSessionId.slice(0, 8)}...</code> [${active}] ${escapeHtml(b.workingDirectory || '~')}`);
        }
        response = lines.join('\n');
      }
      break;
    }

    case '/resume': {
      const bindings = router.listBindings(adapter.channelType)
        .sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
      if (bindings.length === 0) {
        response = 'No sessions to resume.';
        break;
      }
      // Direct resume by index: /resume 1
      if (args && /^\d+$/.test(args)) {
        const idx = parseInt(args, 10) - 1;
        if (idx < 0 || idx >= bindings.length) {
          response = `Invalid index. Use 1-${bindings.length}.`;
          break;
        }
        const target = bindings[idx];
        const oldBinding = router.resolve(msg.address);
        const st = getState();
        const oldTask = st.activeTasks.get(oldBinding.codepilotSessionId);
        if (oldTask) {
          oldTask.abort();
          st.activeTasks.delete(oldBinding.codepilotSessionId);
        }
        router.bindToSession(msg.address, target.codepilotSessionId);
        response = `Resumed session <code>${target.codepilotSessionId.slice(0, 8)}...</code> (${escapeHtml(target.workingDirectory || '~')})`;
        break;
      }
      // Interactive card picker
      const rt = getBridgeContext().runtime || 'claude';
      const { store } = getBridgeContext();
      const { buildResumeSessionCard } = await import('./markdown/feishu.js');
      const sessions = bindings.slice(0, 10).map(b => {
        let lastMessage = '';
        try {
          const { messages } = store.getMessages(b.codepilotSessionId, { limit: 10 });
          const lastUserMsg = [...messages].reverse().find(m => m.role === 'user');
          if (lastUserMsg) {
            lastMessage = lastUserMsg.content.replace(/\n/g, ' ').replace(/[`*\[\]\\'"/{}<>]/g, '').trim();
          }
        } catch { /* best effort */ }
        return {
          bindingId: b.id,
          sessionIdShort: b.codepilotSessionId.slice(0, 8) + '...',
          cwd: b.workingDirectory || '~',
          mode: b.mode,
          active: b.active !== false,
          runtime: rt,
          updatedAt: b.updatedAt || '',
          lastMessage,
        };
      });
      const cardJson = buildResumeSessionCard(msg.address.chatId, sessions);
      await deliver(adapter, {
        address: msg.address,
        text: '',
        cardJson,
      });
      return;
    }

    case '/stop': {
      const binding = router.resolve(msg.address);
      const st = getState();
      const taskAbort = st.activeTasks.get(binding.codepilotSessionId);
      if (taskAbort) {
        taskAbort.abort();
        st.activeTasks.delete(binding.codepilotSessionId);
        response = 'Stopping current task...';
      } else {
        response = 'No task is currently running.';
      }
      break;
    }

    case '/perm': {
      // Text-based permission approval fallback (for channels without inline buttons)
      // Usage: /perm allow <id> | /perm allow_session <id> | /perm deny <id>
      const permParts = args.split(/\s+/);
      const permAction = permParts[0];
      const permId = permParts.slice(1).join(' ');
      if (!permAction || !permId || !['allow', 'allow_session', 'deny'].includes(permAction)) {
        response = 'Usage: /perm allow|allow_session|deny &lt;permission_id&gt;';
        break;
      }
      const callbackData = `perm:${permAction}:${permId}`;
      const handled = broker.handlePermissionCallback(callbackData, msg.address.chatId);
      if (handled) {
        response = `Permission ${permAction}: recorded.`;
      } else {
        response = `Permission not found or already resolved.`;
      }
      break;
    }

    case '/think': {
      const levels = ['low', 'medium', 'high', 'max', 'off'];
      if (!args || !levels.includes(args.toLowerCase())) {
        const current = store.getSetting('bridge_thinking_effort') || 'adaptive (default)';
        response = `Current: <b>${current}</b>\nUsage: /think low|medium|high|max|off`;
        break;
      }
      if (!store.setSetting) {
        response = 'This store does not support runtime settings.';
        break;
      }
      const level = args.toLowerCase();
      if (level === 'off') {
        store.setSetting('bridge_thinking_effort', '');
        response = 'Thinking effort reset to <b>adaptive</b> (model decides).';
      } else {
        store.setSetting('bridge_thinking_effort', level);
        response = `Thinking effort set to <b>${level}</b>.`;
      }
      break;
    }

    case '/help':
      response = [
        '<b>CodePilot Bridge Commands</b>',
        '',
        '<b>AI Commands:</b>',
        '/ask &lt;message&gt; - Ask AI a question',
        '/run &lt;description&gt; - Ask AI to run a command',
        '/code &lt;task&gt; - Ask AI to write code',
        '',
        '<b>Session Commands:</b>',
        '/new [path] - Start new session',
        '/bind &lt;session_id&gt; - Bind to existing session',
        '/cwd /path - Change working directory',
        '/mode plan|code|ask - Change mode',
        '/status - Show current status',
        '/sessions - List recent sessions',
        '/resume [n] - Resume a previous session',
        '/stop - Stop current session',
        '/think low|medium|high|max|off - Set thinking effort',
        '/perm allow|allow_session|deny &lt;id&gt; - Respond to permission request',
        '1/2/3 - Quick permission reply (Feishu/QQ/WeChat, single pending)',
        '/help - Show this help',
      ].join('\n');
      break;

    default: {
      const forwardUnknown = store.getSetting('bridge_forward_unknown_commands') !== 'false';
      if (forwardUnknown) {
        // Forward the entire command text as a prompt to the AI CLI
        await forwardToAI(adapter, msg, text);
        return;
      }
      response = `Unknown command: ${escapeHtml(command)}\nType /help for available commands.`;
    }
  }

  if (response) {
    await deliver(adapter, {
      address: msg.address,
      text: response,
      parseMode: 'HTML',
      replyToMessageId: msg.messageId,
    });
  }
}

// ── SDK Session Update Logic ─────────────────────────────────

const SESSION_INVALIDATING_PATTERNS = [
  'no such session',
  'session not found',
  'session expired',
  'invalid session',
  'resuming session with different model',
  'not authenticated',
  'authentication failed',
  'unauthorized',
  'organization does not have access',
];

function isSessionInvalidatingError(errorMessage: string): boolean {
  const lower = errorMessage.toLowerCase();
  return SESSION_INVALIDATING_PATTERNS.some(p => lower.includes(p));
}

/**
 * Compute the sdkSessionId value to persist after a conversation result.
 * Returns the new value to write, or null if no update is needed.
 *
 * Only clears the session ID for errors that truly invalidate the session
 * (e.g. "no such session"). Recoverable errors (timeout, rate limit)
 * preserve the existing session ID so the next message can resume.
 */
export function computeSdkSessionUpdate(
  sdkSessionId: string | null | undefined,
  hasError: boolean,
  errorMessage?: string,
): string | null {
  if (sdkSessionId) {
    return sdkSessionId;
  }
  if (hasError) {
    if (errorMessage && isSessionInvalidatingError(errorMessage)) {
      return '';
    }
    return null;
  }
  return null;
}

// ── Relay Server for Multi-Bot Communication ────────────────

import http from 'node:http';

let relayServer: http.Server | null = null;

/** Parsed relay peers: name (lowercase) -> { host, port } */
const relayPeers = new Map<string, { host: string; port: number }>();

function parseRelayPeersFromSetting(): void {
  const { store } = getBridgeContext();
  const raw = store.getSetting('bridge_relay_peers') || '';
  relayPeers.clear();
  if (!raw) return;
  for (const entry of raw.split(',')) {
    const parts = entry.split(':').map(s => s.trim());
    if (parts.length >= 3) {
      const port = parseInt(parts[parts.length - 1], 10);
      const host = parts[parts.length - 2];
      const name = parts.slice(0, parts.length - 2).join(':');
      if (name && host && !isNaN(port)) {
        relayPeers.set(name.toLowerCase(), { host, port });
      }
    }
  }
}

export function startRelayServer(): void {
  const { store } = getBridgeContext();
  const port = parseInt(store.getSetting('bridge_relay_port') || '', 10);
  if (!port) return;

  parseRelayPeersFromSetting();

  relayServer = http.createServer(async (req, res) => {
    if (req.method !== 'POST' || req.url !== '/relay') {
      res.writeHead(404);
      res.end('Not found');
      return;
    }

    let body = '';
    for await (const chunk of req) {
      body += chunk;
      if (body.length > 65536) {
        res.writeHead(413);
        res.end('Payload too large');
        return;
      }
    }

    try {
      const data = JSON.parse(body);
      const { chatId, text, senderName, senderType, replyMessageId } = data;
      if (!chatId || !text) {
        res.writeHead(400);
        res.end('Missing chatId or text');
        return;
      }

      // Handle identity exchange: peer bot announces its name + openId
      if (chatId === '__identity__') {
        try {
          const identity = JSON.parse(text);
          if (identity.type === 'identity' && identity.name && identity.openId) {
            const state = getState();
            for (const [, adapter] of state.adapters) {
              if ('registerPeerBot' in adapter && typeof (adapter as any).registerPeerBot === 'function') {
                (adapter as any).registerPeerBot(identity.name, identity.openId);
              }
            }
            console.log(`[relay-server] Registered peer identity: ${identity.name} -> ${identity.openId}`);
            res.writeHead(200);
            res.end('OK');
            return;
          }
        } catch { /* fall through to normal relay */ }
      }

      // Find the first available adapter and inject the message
      const state = getState();
      let injected = false;
      for (const [, adapter] of state.adapters) {
        if (adapter.injectMessage) {
          // Relay messages from other bots are context-only by default
          // unless this bot is explicitly @mentioned in the text.
          const botOpenId = (adapter as any).botOpenId as string | undefined;
          const botName = botOpenId
            ? ((adapter as any).knownBotsByOpenId as Map<string, string>)?.get(botOpenId) || ''
            : '';
          const isMentioned = (botName && text.includes(`@${botName}`))
            || (botName && text.includes(`@[${botName}]`))
            || (botOpenId && text.includes(botOpenId));
          const isContextOnly = (senderType === 'bot') && !isMentioned;

          const msg: InboundMessage = {
            messageId: replyMessageId || `relay-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            address: { channelType: adapter.channelType, chatId },
            text,
            timestamp: Date.now(),
            senderType: senderType || 'bot',
            senderName: senderName || 'unknown-bot',
            isGroup: true,
            contextOnly: isContextOnly || undefined,
          };
          adapter.injectMessage(msg);
          injected = true;
          console.log(`[relay-server] Injected message from ${senderName} to chat ${chatId} (contextOnly=${isContextOnly})`);
          break;
        }
      }

      res.writeHead(injected ? 200 : 503);
      res.end(injected ? 'OK' : 'No adapter available');
    } catch (err) {
      console.error('[relay-server] Error processing relay:', err);
      res.writeHead(500);
      res.end('Internal error');
    }
  });

  relayServer.listen(port, () => {
    console.log(`[relay-server] Listening on port ${port}`);
    if (relayPeers.size > 0) {
      console.log(`[relay-server] Known peers: ${Array.from(relayPeers.entries()).map(([n, p]) => `${n}@${p.host}:${p.port}`).join(', ')}`);
    }
  });
}

export function stopRelayServer(): void {
  if (relayServer) {
    relayServer.close();
    relayServer = null;
    console.log('[relay-server] Stopped');
  }
}

/** Get all relay peer names (lowercase). */
export function getRelayPeerNames(): string[] {
  return Array.from(relayPeers.keys());
}

/**
 * Send a relay message to a peer bot by name.
 * Returns true if the message was sent successfully.
 */
export async function relayToBot(botName: string, chatId: string, text: string, senderName: string, replyMessageId?: string): Promise<boolean> {
  const peer = relayPeers.get(botName.toLowerCase());
  if (!peer) {
    console.warn(`[relay-server] Unknown peer bot: ${botName}`);
    return false;
  }

  const payload = JSON.stringify({ chatId, text, senderName, senderType: 'bot', replyMessageId });

  return new Promise<boolean>((resolve) => {
    const req = http.request({
      hostname: peer.host,
      port: peer.port,
      path: '/relay',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
      timeout: 5000,
    }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('error', (err) => {
      console.warn(`[relay-server] Failed to relay to ${botName}:`, err.message);
      resolve(false);
    });
    req.write(payload);
    req.end();
  });
}

// ── Test-only export ─────────────────────────────────────────
// Exposed so integration tests can exercise handleMessage directly
// without wiring up the full adapter loop.
/** @internal */
export const _testOnly = { handleMessage };
