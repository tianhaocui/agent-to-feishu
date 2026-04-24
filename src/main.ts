/**
 * Daemon entry point for claude-to-im-skill.
 *
 * Assembles all DI implementations and starts the bridge.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

import { initBridgeContext } from 'claude-to-im/src/lib/bridge/context.js';
import * as bridgeManager from 'claude-to-im/src/lib/bridge/bridge-manager.js';
// Side-effect import to trigger adapter self-registration
import 'claude-to-im/src/lib/bridge/adapters/index.js';
import './adapters/feishu-adapter.js';

import type { LLMProvider } from 'claude-to-im/src/lib/bridge/host.js';
import { loadConfig, configToSettings, CTI_HOME } from './config.js';
import type { Config } from './config.js';
import { JsonFileStore } from './store.js';
import { SDKLLMProvider, resolveClaudeCliPath, preflightCheck } from './llm-provider.js';
import { PendingPermissions } from './permission-gateway.js';
import { setupLogger } from './logger.js';

const RUNTIME_DIR = path.join(CTI_HOME, 'runtime');
const STATUS_FILE = path.join(RUNTIME_DIR, 'status.json');
const PID_FILE = path.join(RUNTIME_DIR, 'bridge.pid');

/**
 * Resolve the LLM provider based on the runtime setting.
 * - 'claude' (default): uses Claude Code SDK via SDKLLMProvider
 * - 'codex': uses @openai/codex-sdk via CodexProvider
 * - 'auto': tries Claude first, falls back to Codex
 */
async function resolveProvider(config: Config, pendingPerms: PendingPermissions): Promise<LLMProvider> {
  const runtime = config.runtime;

  if (runtime === 'codex') {
    const { CodexProvider } = await import('./codex-provider.js');
    return new CodexProvider(pendingPerms);
  }

  if (runtime === 'auto') {
    const cliPath = resolveClaudeCliPath();
    if (cliPath) {
      // Auto mode: preflight the resolved CLI before committing to it.
      const check = preflightCheck(cliPath);
      if (check.ok) {
        console.log(`[claude-to-im] Auto: using Claude CLI at ${cliPath} (${check.version})`);
        return new SDKLLMProvider(pendingPerms, cliPath, config.autoApprove);
      }
      // Preflight failed — fall through to Codex instead of silently using a broken CLI
      console.warn(
        `[claude-to-im] Auto: Claude CLI at ${cliPath} failed preflight: ${check.error}\n` +
        `  Falling back to Codex.`,
      );
    } else {
      console.log('[claude-to-im] Auto: Claude CLI not found, falling back to Codex');
    }
    const { CodexProvider } = await import('./codex-provider.js');
    return new CodexProvider(pendingPerms);
  }

  // Default: claude
  const cliPath = resolveClaudeCliPath();
  if (!cliPath) {
    console.error(
      '[claude-to-im] FATAL: Cannot find the `claude` CLI executable.\n' +
      '  Tried: CTI_CLAUDE_CODE_EXECUTABLE env, /usr/local/bin/claude, /opt/homebrew/bin/claude, ~/.npm-global/bin/claude, ~/.local/bin/claude\n' +
      '  Fix: Install Claude Code CLI (https://docs.anthropic.com/en/docs/claude-code) or set CTI_CLAUDE_CODE_EXECUTABLE=/path/to/claude\n' +
      '  Or: Set CTI_RUNTIME=codex to use Codex instead',
    );
    process.exit(1);
  }

  // Preflight: verify the CLI can actually run in the daemon environment.
  // In claude runtime this is fatal — starting with a broken CLI would just
  // defer the error to the first user message, which is harder to diagnose.
  const check = preflightCheck(cliPath);
  if (check.ok) {
    console.log(`[claude-to-im] CLI preflight OK: ${cliPath} (${check.version})`);
  } else {
    console.error(
      `[claude-to-im] FATAL: Claude CLI preflight check failed.\n` +
      `  Path: ${cliPath}\n` +
      `  Error: ${check.error}\n` +
      `  Fix:\n` +
      `    1. Install Claude Code CLI >= 2.x: https://docs.anthropic.com/en/docs/claude-code\n` +
      `    2. Or set CTI_CLAUDE_CODE_EXECUTABLE=/path/to/correct/claude\n` +
      `    3. Or set CTI_RUNTIME=auto to fall back to Codex`,
    );
    process.exit(1);
  }

  return new SDKLLMProvider(pendingPerms, cliPath, config.autoApprove);
}

interface StatusInfo {
  running: boolean;
  pid?: number;
  runId?: string;
  startedAt?: string;
  channels?: string[];
  lastExitReason?: string;
}

function writeStatus(info: StatusInfo): void {
  fs.mkdirSync(RUNTIME_DIR, { recursive: true });
  // Merge with existing status to preserve fields like lastExitReason
  let existing: Record<string, unknown> = {};
  try { existing = JSON.parse(fs.readFileSync(STATUS_FILE, 'utf-8')); } catch { /* first write */ }
  const merged = { ...existing, ...info };
  const tmp = STATUS_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(merged, null, 2), 'utf-8');
  fs.renameSync(tmp, STATUS_FILE);
}

async function main(): Promise<void> {
  const config = loadConfig();
  setupLogger();

  const runId = crypto.randomUUID();
  console.log(`[claude-to-im] Starting bridge (run_id: ${runId})`);

  const settings = configToSettings(config);
  const store = new JsonFileStore(settings);
  const permTimeoutSecs = parseInt(process.env.CTI_PERMISSION_TIMEOUT_SECS || '300', 10) || 300;
  const pendingPerms = new PendingPermissions(permTimeoutSecs * 1000);
  const llm = await resolveProvider(config, pendingPerms);
  console.log(`[claude-to-im] Runtime: ${config.runtime}`);

  const gateway = {
    resolvePendingPermission: (id: string, resolution: { behavior: 'allow' | 'deny'; message?: string; updatedInput?: Record<string, unknown> }) =>
      pendingPerms.resolve(id, resolution),
  };

  initBridgeContext({
    store,
    llm,
    permissions: gateway,
    runtime: config.runtime,
    lifecycle: {
      onBridgeStart: () => {
        // Write authoritative PID from the actual process (not shell $!)
        fs.mkdirSync(RUNTIME_DIR, { recursive: true });
        fs.writeFileSync(PID_FILE, String(process.pid), 'utf-8');
        writeStatus({
          running: true,
          pid: process.pid,
          runId,
          startedAt: new Date().toISOString(),
          channels: config.enabledChannels,
        });
        console.log(`[claude-to-im] Bridge started (PID: ${process.pid}, channels: ${config.enabledChannels.join(', ')})`);
      },
      onBridgeStop: () => {
        writeStatus({ running: false });
        console.log('[claude-to-im] Bridge stopped');
      },
    },
  });

  await bridgeManager.start();

  // Orchestration — multi-agent coordinator/worker mode
  if (config.orchRole && config.orchRole !== 'none') {
    const { initOrchestration, handleOrchMessage, maybeIntercept, getOrchRole } = await import('./orchestration/index.js');
    const { registerOrchestrationHandler, registerOrchestrationInterceptor, registerOrchestrationCompletionCallback } = await import('claude-to-im/src/lib/bridge/bridge-manager.js');
    const relayPeersMap = new Map<string, { host: string; port: number }>();
    if (config.relayPeers) {
      for (const p of config.relayPeers) {
        relayPeersMap.set(p.name.toLowerCase(), { host: p.host, port: p.port });
      }
    }
    // Resolve bot name lazily — adapter sets botName after WS handshake
    const state = bridgeManager.getState();
    const feishuAdapter = state.adapters.get('feishu') as any;
    const getBotName = () => feishuAdapter?.botName || 'unknown';
    initOrchestration({
      orchRole: config.orchRole,
      orchSkills: config.orchSkills || [],
      orchMaxConcurrent: config.orchMaxConcurrent || 3,
      runtime: config.runtime,
      botName: getBotName,
      relayPeers: relayPeersMap,
    });

    // Register hooks into the vendor bridge-manager
    registerOrchestrationHandler(handleOrchMessage as any);
    if (getOrchRole() === 'coordinator') {
      registerOrchestrationInterceptor(maybeIntercept as any);
    }
    if (getOrchRole() === 'worker') {
      const { onStreamCompletion } = await import('./orchestration/worker.js');
      registerOrchestrationCompletionCallback(onStreamCompletion);
    }
  }

  // OAuth Device Flow — obtain user_access_token for lark-mcp
  let oauthManager: import('./oauth/oauth-manager.js').OAuthManager | null = null;
  if (config.feishuOAuthEnabled && config.feishuAppId && config.feishuAppSecret) {
    const adminChatId = config.feishuOAuthAdminChatId;
    if (adminChatId) {
      const { OAuthManager } = await import('./oauth/oauth-manager.js');
      const state = bridgeManager.getState();
      const adapter = state.adapters.get('feishu') as any;
      oauthManager = new OAuthManager(
        {
          appId: config.feishuAppId,
          appSecret: config.feishuAppSecret,
          domain: `https://${config.feishuDomain === 'lark.com' ? 'open.larksuite.com' : 'open.feishu.cn'}`,
          ctiHome: CTI_HOME,
          adminChatId,
          scope: config.feishuOAuthScope,
        },
        async (chatId, cardJson) => { adapter?.sendRawCard?.(chatId, cardJson); },
        async (messageId, cardJson) => { adapter?.patchCardMessage?.(messageId, cardJson); },
      );
      await oauthManager.ensureAuth();
      oauthManager.startRefreshTimer();
      console.log('[claude-to-im] OAuth manager initialized');
    } else {
      console.warn('[claude-to-im] OAuth enabled but CTI_FEISHU_OAUTH_ADMIN_CHAT_ID not set');
    }
  }

  // Periodic cleanup of expired dedup keys
  const dedupCleanupInterval = setInterval(() => {
    store.cleanupExpiredDedup();
  }, 60_000);

  // Graceful shutdown
  let shuttingDown = false;
  const shutdown = async (signal?: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    const reason = signal ? `signal: ${signal}` : 'shutdown requested';
    console.log(`[claude-to-im] Shutting down (${reason})...`);
    clearInterval(dedupCleanupInterval);
    oauthManager?.stopRefreshTimer();
    pendingPerms.denyAll();
    await bridgeManager.stop();
    writeStatus({ running: false, lastExitReason: reason });
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGHUP', () => shutdown('SIGHUP'));

  // ── Exit diagnostics ──
  process.on('unhandledRejection', (reason) => {
    console.error('[claude-to-im] unhandledRejection:', reason instanceof Error ? reason.stack || reason.message : reason);
    writeStatus({ running: false, lastExitReason: `unhandledRejection: ${reason instanceof Error ? reason.message : String(reason)}` });
  });
  process.on('uncaughtException', (err) => {
    console.error('[claude-to-im] uncaughtException:', err.stack || err.message);
    writeStatus({ running: false, lastExitReason: `uncaughtException: ${err.message}` });
    process.exit(1);
  });
  process.on('beforeExit', (code) => {
    console.log(`[claude-to-im] beforeExit (code: ${code})`);
  });
  process.on('exit', (code) => {
    console.log(`[claude-to-im] exit (code: ${code})`);
  });

  // ── Heartbeat to keep event loop alive ──
  // setInterval is ref'd by default, preventing Node from exiting
  // when the event loop would otherwise be empty.
  setInterval(() => { /* keepalive */ }, 45_000);
}

main().catch((err) => {
  console.error('[claude-to-im] Fatal error:', err instanceof Error ? err.stack || err.message : err);
  try { writeStatus({ running: false, lastExitReason: `fatal: ${err instanceof Error ? err.message : String(err)}` }); } catch { /* ignore */ }
  process.exit(1);
});
