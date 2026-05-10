/**
 * Worker thread entry point — runs one bot instance.
 * Receives CTI_HOME via workerData, disables HTTP relay,
 * and uses parentPort for inter-bot communication.
 *
 * IMPORTANT: process.env.CTI_HOME must be set BEFORE importing
 * any module that reads it (config.ts, store.ts). We use dynamic
 * imports to ensure correct ordering.
 */

import { workerData, parentPort, isMainThread } from 'node:worker_threads';
import crypto from 'node:crypto';

if (isMainThread || !parentPort) {
  console.error('[worker-entry] Must be run as a Worker Thread');
  process.exit(1);
}

const { ctiHome, botName } = workerData as { ctiHome: string; botName: string };

// Set env BEFORE any module reads it
process.env.CTI_HOME = ctiHome;
process.env.CTI_RELAY_PORT = '';

async function main(): Promise<void> {
  // Dynamic imports — these modules read process.env.CTI_HOME at load time
  const { initBridgeContext } = await import('claude-to-im/src/lib/bridge/context.js');
  const bridgeManager = await import('claude-to-im/src/lib/bridge/bridge-manager.js');
  await import('claude-to-im/src/lib/bridge/adapters/index.js');
  await import('./adapters/feishu-adapter.js');

  const { loadConfig, configToSettings, CTI_HOME } = await import('./config.js');
  const { JsonFileStore } = await import('./store.js');
  const { SDKLLMProvider, resolveClaudeCliPath, preflightCheck } = await import('./llm-provider.js');
  const { PendingPermissions } = await import('./permission-gateway.js');
  const { setupLogger } = await import('./logger.js');

  const config = loadConfig();
  // Relay server is handled by the orchestrator — workers must not bind it
  config.relayPort = undefined;
  config.relayPeers = undefined;
  setupLogger();

  const runId = crypto.randomUUID();
  console.log(`[worker:${botName}] Starting (run_id: ${runId}, CTI_HOME: ${ctiHome})`);

  const settings = configToSettings(config);
  const store = new JsonFileStore(settings);
  const permTimeoutSecs = parseInt(process.env.CTI_PERMISSION_TIMEOUT_SECS || '300', 10) || 300;
  const pendingPerms = new PendingPermissions(permTimeoutSecs * 1000);

  // Resolve LLM provider
  let llm: any;
  const runtime = config.runtime;
  if (runtime === 'codex') {
    const { CodexProvider } = await import('./codex-provider.js');
    llm = new CodexProvider(pendingPerms);
  } else if (runtime === 'auto') {
    const cliPath = resolveClaudeCliPath();
    if (cliPath) {
      const check = preflightCheck(cliPath);
      if (check.ok) {
        console.log(`[worker:${botName}] Auto: using Claude CLI at ${cliPath} (${check.version})`);
        llm = new SDKLLMProvider(pendingPerms, cliPath, config.autoApprove);
      }
    }
    if (!llm) {
      console.log(`[worker:${botName}] Auto: falling back to Codex`);
      const { CodexProvider } = await import('./codex-provider.js');
      llm = new CodexProvider(pendingPerms);
    }
  } else {
    const cliPath = resolveClaudeCliPath();
    if (!cliPath) throw new Error('Cannot find the `claude` CLI executable');
    const check = preflightCheck(cliPath);
    if (!check.ok) throw new Error(`Claude CLI preflight failed: ${check.error}`);
    console.log(`[worker:${botName}] CLI preflight OK: ${cliPath} (${check.version})`);
    llm = new SDKLLMProvider(pendingPerms, cliPath, config.autoApprove);
  }

  console.log(`[worker:${botName}] Runtime: ${runtime}`);

  const gateway = {
    resolvePendingPermission: (id: string, resolution: { behavior: 'allow' | 'deny'; message?: string; updatedInput?: Record<string, unknown> }) =>
      pendingPerms.resolve(id, resolution),
  };

  initBridgeContext({
    store,
    llm,
    permissions: gateway,
    runtime,
    lifecycle: {
      onBridgeStart: () => { console.log(`[worker:${botName}] Bridge started`); },
      onBridgeStop: () => { console.log(`[worker:${botName}] Bridge stopped`); },
    },
  });

  await bridgeManager.start();

  // Wire up parentPort relay
  const port = parentPort!;
  const state = bridgeManager.getState();
  const adapter = state.adapters.get('feishu') as any;

  if (adapter?.botOpenId) {
    port.postMessage({ type: 'identity', name: botName, openId: adapter.botOpenId });
  }

  port.on('message', (msg: any) => {
    if (msg.type === 'relay' && msg.payload) {
      const { chatId, text, senderName, senderType, replyMessageId } = msg.payload;
      if (adapter?.injectMessage) {
        const botOpenId = adapter.botOpenId as string | undefined;
        const myName = botOpenId
          ? (adapter.knownBotsByOpenId as Map<string, string>)?.get(botOpenId) || ''
          : '';
        const isMentioned = (myName && text.includes(`@${myName}`))
          || (myName && text.includes(`@[${myName}]`))
          || (botOpenId && text.includes(botOpenId));
        const isContextOnly = (senderType === 'bot') && !isMentioned;

        adapter.injectMessage({
          messageId: replyMessageId || `relay-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          address: { channelType: 'feishu', chatId },
          text,
          timestamp: Date.now(),
          senderType: senderType || 'bot',
          senderName: senderName || 'unknown-bot',
          isGroup: true,
          contextOnly: isContextOnly || undefined,
        });
        console.log(`[worker:${botName}] Injected relay from ${senderName} (contextOnly=${isContextOnly})`);
      }
    } else if (msg.type === 'identity' && msg.name && msg.openId) {
      if (adapter?.registerPeerBot) {
        adapter.registerPeerBot(msg.name, msg.openId);
        console.log(`[worker:${botName}] Registered peer: ${msg.name} -> ${msg.openId}`);
      }
    } else if (msg.type === 'peer-reset' && msg.name) {
      if (adapter?.unregisterPeerBot) {
        adapter.unregisterPeerBot(msg.name);
        console.log(`[worker:${botName}] Cleared stale peer: ${msg.name}`);
      }
    }
  });

  // OAuth setup
  if (config.feishuOAuthEnabled && config.feishuAppId && config.feishuAppSecret) {
    const adminChatId = config.feishuOAuthAdminChatId;
    if (adminChatId) {
      const { OAuthManager } = await import('./oauth/oauth-manager.js');
      const oauthManager = new OAuthManager(
        {
          appId: config.feishuAppId,
          appSecret: config.feishuAppSecret,
          domain: `https://${config.feishuDomain === 'lark.com' ? 'open.larksuite.com' : 'open.feishu.cn'}`,
          ctiHome: CTI_HOME,
          adminChatId,
          scope: config.feishuOAuthScope,
        },
        async (chatId: string, cardJson: any) => { adapter?.sendRawCard?.(chatId, cardJson); },
        async (messageId: string, cardJson: any) => { adapter?.patchCardMessage?.(messageId, cardJson); },
      );
      await oauthManager.ensureAuth();
      oauthManager.startRefreshTimer();
      console.log(`[worker:${botName}] OAuth manager initialized`);
    }
  }

  setInterval(() => { store.cleanupExpiredDedup(); }, 60_000);
  setInterval(() => { /* keepalive */ }, 45_000);
}

main().catch((err) => {
  console.error(`[worker:${botName}] Fatal:`, err instanceof Error ? err.stack || err.message : err);
  process.exit(1);
});
