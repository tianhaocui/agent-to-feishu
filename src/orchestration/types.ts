// ── Orchestration Types ──────────────────────────────────

export type OrchMessageType =
  | 'task:assign'
  | 'task:accept'
  | 'task:reject'
  | 'task:progress'
  | 'task:complete'
  | 'task:fail'
  | 'capability:announce'
  | 'capability:query';

export interface OrchMessage {
  protocol: 'orchestration';
  type: OrchMessageType;
  taskId?: string;
  payload: Record<string, unknown>;
  senderName: string;
  chatId: string;
}

export type TaskStatus = 'queued' | 'assigned' | 'running' | 'completed' | 'failed' | 'cancelled';

export interface OrchTask {
  id: string;
  parentId?: string;
  description: string;
  status: TaskStatus;
  assignedTo?: string;
  result?: string;
  error?: string;
  createdAt: number;
  updatedAt: number;
  chatId: string;
  originMessageId?: string;
  cardMessageId?: string;
  timeoutMs: number;
  attempt: number;
}

export interface BotCapability {
  name: string;
  runtime: string;
  skills: string[];
  maxConcurrent: number;
  runningTasks: number;
  lastSeen: number;
}

export interface DecomposeResult {
  action: 'handle_directly' | 'decompose';
  tasks?: Array<{
    description: string;
    requiredSkills?: string[];
    assignTo?: string;
  }>;
}

export type OrchRole = 'coordinator' | 'worker' | 'none';
