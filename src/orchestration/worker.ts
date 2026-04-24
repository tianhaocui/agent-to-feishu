import type { OrchMessage } from './types.js';
import type { OrchTaskStore } from './task-store.js';
import http from 'node:http';

let taskStore: OrchTaskStore | null = null;
let getSelfName: () => string = () => 'unknown';
let relayPeersRef: Map<string, { host: string; port: number }> | null = null;

// Track active orchestration tasks: taskId -> { coordinatorName, chatId }
const activeOrchTasks = new Map<string, { coordinatorName: string; chatId: string }>();

export function initWorker(store: OrchTaskStore, botNameGetter: () => string, peers: Map<string, { host: string; port: number }>): void {
  taskStore = store;
  getSelfName = botNameGetter;
  relayPeersRef = peers;
}

export function sendOrchMessage(targetBot: string, msg: Omit<OrchMessage, 'protocol'>): Promise<boolean> {
  if (!relayPeersRef) return Promise.resolve(false);
  const peer = relayPeersRef.get(targetBot.toLowerCase());
  if (!peer) {
    console.warn(`[orch-worker] Unknown peer: ${targetBot}`);
    return Promise.resolve(false);
  }

  const payload = JSON.stringify({ ...msg, protocol: 'orchestration' });
  return new Promise<boolean>((resolve) => {
    const req = http.request({
      hostname: peer.host,
      port: peer.port,
      path: '/relay',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
      timeout: 10_000,
    }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('error', (err) => {
      console.warn(`[orch-worker] Relay error to ${targetBot}:`, err.message);
      resolve(false);
    });
    req.write(payload);
    req.end();
  });
}
export async function handleTaskAssign(msg: OrchMessage, injectMessage: (text: string, chatId: string, senderName: string) => void): Promise<void> {
  if (!taskStore) return;
  const { taskId, payload } = msg;
  if (!taskId) return;

  const description = payload.description as string;
  const coordinatorName = msg.senderName;

  console.log(`[orch-worker] Received task:assign taskId=${taskId} from=${coordinatorName}: ${description.slice(0, 100)}`);

  // Accept the task
  await sendOrchMessage(coordinatorName, {
    type: 'task:accept',
    taskId,
    payload: {},
    senderName: getSelfName(),
    chatId: msg.chatId,
  });

  // Track for completion callback
  activeOrchTasks.set(taskId, { coordinatorName, chatId: msg.chatId });

  // Inject as a user message into the conversation engine
  const taskPrompt = `[协调任务 ${taskId}]\n${description}`;
  injectMessage(taskPrompt, msg.chatId, coordinatorName);
}

export async function reportTaskComplete(coordinatorName: string, taskId: string, chatId: string, result: string): Promise<void> {
  await sendOrchMessage(coordinatorName, {
    type: 'task:complete',
    taskId,
    payload: { result: result.slice(0, 8192) },
    senderName: getSelfName(),
    chatId,
  });
  console.log(`[orch-worker] Reported task:complete taskId=${taskId}`);
}

export async function reportTaskFail(coordinatorName: string, taskId: string, chatId: string, error: string): Promise<void> {
  await sendOrchMessage(coordinatorName, {
    type: 'task:fail',
    taskId,
    payload: { error: error.slice(0, 2048) },
    senderName: getSelfName(),
    chatId,
  });
  console.log(`[orch-worker] Reported task:fail taskId=${taskId}`);
}

export async function announceCapabilities(skills: string[], runtime: string, maxConcurrent: number): Promise<void> {
  if (!relayPeersRef) return;
  for (const [peerName] of relayPeersRef) {
    await sendOrchMessage(peerName, {
      type: 'capability:announce',
      payload: { name: getSelfName(), runtime, skills, maxConcurrent, runningTasks: 0 },
      senderName: getSelfName(),
      chatId: '__orchestration__',
    });
  }
  console.log(`[orch-worker] Announced capabilities to ${relayPeersRef.size} peers`);
}

const TASK_PREFIX_RE = /^\[协调任务 ([a-f0-9-]+)\]/;

export async function onStreamCompletion(msgText: string, chatId: string, responseText: string, hasError: boolean): Promise<void> {
  const match = msgText.match(TASK_PREFIX_RE);
  if (!match) return;

  const taskId = match[1];
  const tracked = activeOrchTasks.get(taskId);
  if (!tracked) return;
  activeOrchTasks.delete(taskId);

  if (hasError) {
    await reportTaskFail(tracked.coordinatorName, taskId, tracked.chatId, responseText.slice(0, 2048) || 'stream error');
  } else {
    await reportTaskComplete(tracked.coordinatorName, taskId, tracked.chatId, responseText);
  }
}
