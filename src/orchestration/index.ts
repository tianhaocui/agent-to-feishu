import type { OrchMessage, OrchRole, BotCapability } from './types.js';
import { OrchTaskStore } from './task-store.js';
import { CapabilityRegistry } from './capability-registry.js';
import { initCoordinator, handleTaskComplete, handleTaskFail, handleTaskAccept } from './coordinator.js';
import { initWorker, handleTaskAssign, announceCapabilities } from './worker.js';

let orchRole: OrchRole = 'none';
let taskStore: OrchTaskStore;
let capRegistry: CapabilityRegistry;

export interface OrchConfig {
  orchRole: OrchRole;
  orchSkills: string[];
  orchMaxConcurrent: number;
  runtime: string;
  botName: string | (() => string);
  relayPeers: Map<string, { host: string; port: number }>;
}

let resolveBotName: () => string = () => 'unknown';

export function getBotName(): string {
  return resolveBotName();
}

export function initOrchestration(config: OrchConfig): void {
  orchRole = config.orchRole;
  if (orchRole === 'none') return;

  resolveBotName = typeof config.botName === 'function' ? config.botName : () => config.botName as string;

  taskStore = new OrchTaskStore();
  capRegistry = new CapabilityRegistry();

  initWorker(taskStore, resolveBotName, config.relayPeers);

  if (orchRole === 'coordinator') {
    initCoordinator(taskStore, capRegistry, resolveBotName);
    const pruned = taskStore.pruneOld();
    if (pruned > 0) console.log(`[orchestration] Pruned ${pruned} old tasks`);
  }

  if (orchRole === 'worker') {
    const skills = config.orchSkills;
    const runtime = config.runtime;
    const maxConcurrent = config.orchMaxConcurrent;
    const poll = (attempt: number) => {
      const name = resolveBotName();
      if (name !== 'unknown') {
        announceCapabilities(skills, runtime, maxConcurrent).catch(err => {
          console.warn('[orchestration] Failed to announce capabilities:', err);
        });
      } else if (attempt >= 30) {
        console.error('[orchestration] botName still unknown after 30s, skipping capability announce');
      } else {
        setTimeout(() => poll(attempt + 1), 1000);
      }
    };
    setTimeout(() => poll(0), 2000);
  }

  console.log(`[orchestration] Initialized as ${orchRole} (bot: ${resolveBotName()})`);
}

export async function handleOrchMessage(
  data: OrchMessage,
  getState: () => any,
  getBridgeContext: () => any,
): Promise<void> {
  if (orchRole === 'none') return;

  console.log(`[orchestration] Received ${data.type} from ${data.senderName} taskId=${data.taskId || 'n/a'}`);

  switch (data.type) {
    case 'capability:announce': {
      if (orchRole !== 'coordinator') break;
      const cap = data.payload as unknown as BotCapability;
      capRegistry.register(cap);
      break;
    }

    case 'task:assign': {
      if (orchRole !== 'worker') break;
      const state = getState();
      const adapter = [...state.adapters.values()][0];
      if (!adapter?.injectMessage) break;
      await handleTaskAssign(data, (text, chatId, senderName) => {
        adapter.injectMessage({
          messageId: `orch-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          address: { chatId, channelType: 'feishu' },
          text,
          senderType: 'bot',
          senderName,
          timestamp: Date.now(),
        });
      });
      break;
    }

    case 'task:accept': {
      if (orchRole !== 'coordinator') break;
      await handleTaskAccept(data);
      break;
    }

    case 'task:complete': {
      if (orchRole !== 'coordinator') break;
      await handleTaskComplete(data);
      break;
    }

    case 'task:fail': {
      if (orchRole !== 'coordinator') break;
      await handleTaskFail(data);
      break;
    }

    default:
      console.warn(`[orchestration] Unknown message type: ${data.type}`);
  }
}

export function getOrchRole(): OrchRole {
  return orchRole;
}

export { maybeIntercept } from './coordinator.js';
