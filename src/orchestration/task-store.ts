import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { OrchTask, TaskStatus } from './types.js';
import { CTI_HOME } from '../config.js';

const DATA_DIR = path.join(CTI_HOME, 'data');
const TASKS_FILE = path.join(DATA_DIR, 'orch-tasks.json');

function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

function readJson<T>(filePath: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as T;
  } catch {
    return fallback;
  }
}

function atomicWrite(filePath: string, data: string): void {
  const tmp = filePath + '.tmp';
  fs.writeFileSync(tmp, data, 'utf-8');
  fs.renameSync(tmp, filePath);
}

export class OrchTaskStore {
  private tasks = new Map<string, OrchTask>();
  private writeTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    ensureDir(DATA_DIR);
    const saved = readJson<Record<string, OrchTask>>(TASKS_FILE, {});
    for (const [id, task] of Object.entries(saved)) {
      this.tasks.set(id, task);
    }
  }

  private schedulePersist(): void {
    if (this.writeTimer) return;
    this.writeTimer = setTimeout(() => {
      this.writeTimer = null;
      const obj: Record<string, OrchTask> = {};
      for (const [id, task] of this.tasks) obj[id] = task;
      atomicWrite(TASKS_FILE, JSON.stringify(obj, null, 2));
    }, 500);
  }
  create(fields: Pick<OrchTask, 'description' | 'chatId' | 'parentId' | 'assignedTo' | 'originMessageId'> & { timeoutMs?: number }): OrchTask {
    const now = Date.now();
    const task: OrchTask = {
      id: crypto.randomUUID(),
      description: fields.description,
      status: fields.assignedTo ? 'assigned' : 'queued',
      assignedTo: fields.assignedTo,
      parentId: fields.parentId,
      chatId: fields.chatId,
      originMessageId: fields.originMessageId,
      createdAt: now,
      updatedAt: now,
      timeoutMs: fields.timeoutMs ?? 5 * 60_000,
      attempt: 0,
    };
    this.tasks.set(task.id, task);
    this.schedulePersist();
    return task;
  }

  get(id: string): OrchTask | undefined {
    return this.tasks.get(id);
  }

  update(id: string, fields: Partial<Pick<OrchTask, 'status' | 'result' | 'error' | 'assignedTo' | 'cardMessageId' | 'attempt'>>): OrchTask | undefined {
    const task = this.tasks.get(id);
    if (!task) return undefined;
    Object.assign(task, fields, { updatedAt: Date.now() });
    this.schedulePersist();
    return task;
  }

  listByParent(parentId: string): OrchTask[] {
    return [...this.tasks.values()].filter(t => t.parentId === parentId);
  }

  listByChat(chatId: string): OrchTask[] {
    return [...this.tasks.values()].filter(t => t.chatId === chatId);
  }

  listByStatus(status: TaskStatus): OrchTask[] {
    return [...this.tasks.values()].filter(t => t.status === status);
  }

  listRunningByWorker(workerName: string): OrchTask[] {
    return [...this.tasks.values()].filter(t => t.assignedTo === workerName && (t.status === 'assigned' || t.status === 'running'));
  }

  listActiveTasks(): OrchTask[] {
    return [...this.tasks.values()].filter(t => t.status !== 'completed' && t.status !== 'failed' && t.status !== 'cancelled');
  }

  pruneOld(maxAgeMs: number = 24 * 60 * 60_000): number {
    const cutoff = Date.now() - maxAgeMs;
    let pruned = 0;
    for (const [id, task] of this.tasks) {
      if (task.updatedAt < cutoff && (task.status === 'completed' || task.status === 'failed' || task.status === 'cancelled')) {
        this.tasks.delete(id);
        pruned++;
      }
    }
    if (pruned > 0) this.schedulePersist();
    return pruned;
  }

  flush(): void {
    if (this.writeTimer) {
      clearTimeout(this.writeTimer);
      this.writeTimer = null;
    }
    const obj: Record<string, OrchTask> = {};
    for (const [id, task] of this.tasks) obj[id] = task;
    atomicWrite(TASKS_FILE, JSON.stringify(obj, null, 2));
  }
}
