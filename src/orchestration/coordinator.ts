import type { OrchMessage, OrchTask, DecomposeResult } from './types.js';
import type { OrchTaskStore } from './task-store.js';
import type { CapabilityRegistry } from './capability-registry.js';
import { buildTaskBoardCard, buildSummaryCard } from './cards.js';
import { sendOrchMessage } from './worker.js';

let taskStore: OrchTaskStore;
let capRegistry: CapabilityRegistry;
let getSelfName: () => string = () => 'unknown';

const DECOMPOSE_HINTS = /同时|并行|分别|一边.*一边|顺便|另外|以及|与此同时|parallel|meanwhile|also\s+(?:check|review|test|run)/i;
const ACTION_VERBS = /写|测试|检查|分析|重构|修复|创建|部署|review|test|check|build|deploy|fix|refactor|create/;

function looksDecomposable(text: string): boolean {
  if (DECOMPOSE_HINTS.test(text)) return true;
  const sentences = text.split(/[。；;！!？?\n]+/).filter(s => s.trim().length > 5);
  if (sentences.length < 4) return false;
  const actionSentences = sentences.filter(s => ACTION_VERBS.test(s));
  return actionSentences.length >= 2;
}

// Pending parent tasks waiting for sub-task completion
const pendingParents = new Map<string, { parentTask: OrchTask; adapter: unknown; address: unknown }>();

export function initCoordinator(store: OrchTaskStore, registry: CapabilityRegistry, botNameGetter: () => string): void {
  taskStore = store;
  capRegistry = registry;
  getSelfName = botNameGetter;
}

/**
 * Called from bridge-manager handleMessage before the conversation engine.
 * Returns true if the message was intercepted (coordinator will handle it).
 */
export async function maybeIntercept(
  adapter: any,
  msg: any,
  getBridgeContext: () => any,
): Promise<boolean> {
  if (!taskStore || !capRegistry) return false;

  const workers = capRegistry.available();
  if (workers.length === 0) return false;

  const { llm } = getBridgeContext();
  if (!llm) return false;

  const userText = msg.text?.trim();
  if (!userText || userText.length < 30) return false;

  // Quick heuristic: only invoke LLM analysis when the message looks like
  // it could benefit from multi-worker decomposition (contains parallel/multi
  // keywords, or explicitly mentions multiple distinct tasks).
  if (!looksDecomposable(userText)) return false;

  // Use AI to decide whether to decompose
  const decompose = await analyzeTask(llm, userText);
  if (!decompose || decompose.action === 'handle_directly') return false;
  if (!decompose.tasks || decompose.tasks.length === 0) return false;

  // Create parent task
  const parentTask = taskStore.create({
    description: userText,
    chatId: msg.address.chatId,
    originMessageId: msg.messageId,
  });
  taskStore.update(parentTask.id, { status: 'running' });

  // Create and dispatch sub-tasks
  const subTasks: OrchTask[] = [];
  for (const t of decompose.tasks) {
    const workerName = t.assignTo || capRegistry.matchWorker(t.requiredSkills || []);
    if (!workerName || workerName === 'unknown') {
      console.warn(`[orch-coordinator] No valid worker for: ${t.description.slice(0, 60)}`);
      continue;
    }

    const subTask = taskStore.create({
      description: t.description,
      chatId: msg.address.chatId,
      parentId: parentTask.id,
      assignedTo: workerName,
    });
    subTasks.push(subTask);

    // Dispatch via relay
    const sent = await sendOrchMessage(workerName, {
      type: 'task:assign',
      taskId: subTask.id,
      payload: { description: t.description, parentTaskId: parentTask.id },
      senderName: getSelfName(),
      chatId: msg.address.chatId,
    });

    if (sent) {
      capRegistry.incrementRunning(workerName);
      console.log(`[orch-coordinator] Dispatched task ${subTask.id} to ${workerName}`);
    } else {
      taskStore.update(subTask.id, { status: 'failed', error: 'relay failed' });
    }
  }

  // If no sub-tasks were successfully dispatched, don't intercept
  const dispatched = subTasks.filter(t => t.status !== 'failed');
  if (dispatched.length === 0) {
    taskStore.update(parentTask.id, { status: 'failed', error: 'no workers reachable' });
    return false;
  }

  // Send task board card
  const { deliver } = await import('claude-to-im/src/lib/bridge/delivery-layer.js');
  const cardJson = buildTaskBoardCard(parentTask, subTasks);
  const result = await deliver(adapter, {
    address: msg.address,
    text: '',
    cardJson,
    replyToMessageId: msg.messageId,
  });

  if (result.ok && result.messageId) {
    taskStore.update(parentTask.id, { cardMessageId: result.messageId });
  }

  // Track for completion aggregation
  pendingParents.set(parentTask.id, { parentTask, adapter, address: msg.address });

  // Set up timeout
  const timeoutMs = subTasks.length > 0 ? Math.max(...subTasks.map(t => t.timeoutMs)) : 5 * 60_000;
  setTimeout(() => checkTimeout(parentTask.id), timeoutMs + 5000);

  return true;
}
async function analyzeTask(llm: any, userText: string): Promise<DecomposeResult | null> {
  const workersDesc = capRegistry.describeWorkers();
  const systemPrompt = `你是一个任务协调者。分析用户的请求，决定是否需要拆分为子任务分配给不同的 worker 并行执行。

可用 Worker：
${workersDesc}

规则：
- 如果任务简单或只需要一个 worker，回复 {"action": "handle_directly"}
- 如果需要多个 worker 并行处理不同部分，回复：
  {"action": "decompose", "tasks": [{"description": "具体任务描述", "requiredSkills": ["skill"], "assignTo": "worker名"}]}
- 每个子任务必须是独立可执行的，包含足够的上下文
- 考虑 worker 的当前负载和擅长领域
- 只输出 JSON，不要其他内容`;

  try {
    const stream = llm.streamChat({
      prompt: userText,
      sessionId: `orch-analyze-${Date.now()}`,
      systemPrompt,
    });

    let fullText = '';
    const reader = stream.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      for (const line of (value as string).split('\n')) {
        if (!line.startsWith('data: ')) continue;
        try {
          const event = JSON.parse(line.slice(6));
          if (event.type === 'text' && typeof event.data === 'string') {
            fullText += event.data;
          }
        } catch { /* skip malformed */ }
      }
    }

    // Extract JSON from response
    const jsonMatch = fullText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;
    return JSON.parse(jsonMatch[0]) as DecomposeResult;
  } catch (err) {
    console.error('[orch-coordinator] Task analysis failed:', err);
    return null;
  }
}

export async function handleTaskComplete(msg: OrchMessage): Promise<void> {
  const { taskId, payload } = msg;
  if (!taskId) return;

  const task = taskStore.get(taskId);
  if (!task) {
    console.warn(`[orch-coordinator] task:complete for unknown task ${taskId}`);
    return;
  }

  taskStore.update(taskId, {
    status: 'completed',
    result: (payload.result as string) || '',
  });
  capRegistry.decrementRunning(msg.senderName);
  console.log(`[orch-coordinator] Task ${taskId} completed by ${msg.senderName}`);

  if (task.parentId) {
    await checkParentCompletion(task.parentId);
  }
}

export async function handleTaskFail(msg: OrchMessage): Promise<void> {
  const { taskId, payload } = msg;
  if (!taskId) return;

  taskStore.update(taskId, {
    status: 'failed',
    error: (payload.error as string) || 'unknown error',
  });
  capRegistry.decrementRunning(msg.senderName);
  console.log(`[orch-coordinator] Task ${taskId} failed by ${msg.senderName}: ${payload.error}`);

  const task = taskStore.get(taskId);
  if (task?.parentId) {
    await checkParentCompletion(task.parentId);
  }
}

export async function handleTaskAccept(msg: OrchMessage): Promise<void> {
  const { taskId } = msg;
  if (!taskId) return;
  taskStore.update(taskId, { status: 'running' });
  console.log(`[orch-coordinator] Task ${taskId} accepted by ${msg.senderName}`);

  // Update board card
  const task = taskStore.get(taskId);
  if (task?.parentId) {
    await updateBoardCard(task.parentId);
  }
}

async function checkParentCompletion(parentId: string): Promise<void> {
  const subTasks = taskStore.listByParent(parentId);
  const allDone = subTasks.every(t => t.status === 'completed' || t.status === 'failed');

  // Update board card
  await updateBoardCard(parentId);

  if (!allDone) return;

  const pending = pendingParents.get(parentId);
  if (!pending) return;
  pendingParents.delete(parentId);

  const { parentTask, adapter, address } = pending;
  const completed = subTasks.filter(t => t.status === 'completed');
  const failed = subTasks.filter(t => t.status === 'failed');

  // Synthesize results
  let summary: string;
  if (completed.length > 0) {
    const resultParts = completed.map(t =>
      `**${t.assignedTo}** — ${t.description}:\n${t.result || '(无结果)'}`,
    );
    summary = resultParts.join('\n\n---\n\n');
    if (failed.length > 0) {
      summary += `\n\n**失败的任务 (${failed.length}):**\n` +
        failed.map(t => `- ${t.description}: ${t.error}`).join('\n');
    }
  } else {
    summary = '所有子任务均失败:\n' + failed.map(t => `- ${t.description}: ${t.error}`).join('\n');
  }

  taskStore.update(parentId, { status: completed.length > 0 ? 'completed' : 'failed', result: summary });

  // Send summary to chat
  const { deliver } = await import('claude-to-im/src/lib/bridge/delivery-layer.js');
  const cardJson = buildSummaryCard(parentTask, summary);
  await deliver(adapter as any, {
    address: address as any,
    text: '',
    cardJson,
  });
}

async function updateBoardCard(parentId: string): Promise<void> {
  const parentTask = taskStore.get(parentId);
  if (!parentTask?.cardMessageId) return;

  const pending = pendingParents.get(parentId);
  if (!pending) return;

  const subTasks = taskStore.listByParent(parentId);
  const cardJson = buildTaskBoardCard(parentTask, subTasks);

  const { adapter } = pending;
  if ((adapter as any).patchCardMessage) {
    try {
      await (adapter as any).patchCardMessage(parentTask.cardMessageId, cardJson);
    } catch (err) {
      console.warn('[orch-coordinator] Failed to update board card:', err);
    }
  }
}

function checkTimeout(parentId: string): void {
  const subTasks = taskStore.listByParent(parentId);
  const now = Date.now();
  for (const task of subTasks) {
    if ((task.status === 'assigned' || task.status === 'running') && now - task.createdAt > task.timeoutMs) {
      taskStore.update(task.id, { status: 'failed', error: 'timeout' });
      if (task.assignedTo) capRegistry.decrementRunning(task.assignedTo);
      console.warn(`[orch-coordinator] Task ${task.id} timed out (assigned to ${task.assignedTo})`);
    }
  }
  // Re-check parent completion after timeout handling
  checkParentCompletion(parentId).catch(() => {});
}

