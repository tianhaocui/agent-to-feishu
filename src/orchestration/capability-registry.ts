import fs from 'node:fs';
import path from 'node:path';
import type { BotCapability } from './types.js';
import { CTI_HOME } from '../config.js';

const DATA_DIR = path.join(CTI_HOME, 'data');
const CAP_FILE = path.join(DATA_DIR, 'orch-capabilities.json');

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

export class CapabilityRegistry {
  private caps = new Map<string, BotCapability>();

  constructor() {
    const saved = readJson<Record<string, BotCapability>>(CAP_FILE, {});
    for (const [name, cap] of Object.entries(saved)) {
      this.caps.set(name, cap);
    }
  }

  register(cap: BotCapability): void {
    if (!cap.name || cap.name === 'unknown') {
      console.warn(`[orch-capability] Rejected registration with invalid name: ${cap.name}`);
      return;
    }
    cap.lastSeen = Date.now();
    this.caps.set(cap.name, cap);
    this.persist();
    console.log(`[orch-capability] Registered: ${cap.name} (${cap.runtime}) skills=[${cap.skills.join(',')}]`);
  }

  get(name: string): BotCapability | undefined {
    return this.caps.get(name);
  }

  all(): BotCapability[] {
    return [...this.caps.values()];
  }

  available(): BotCapability[] {
    return this.all().filter(c => c.runningTasks < c.maxConcurrent);
  }

  matchWorker(requiredSkills: string[]): string | null {
    if (requiredSkills.length === 0) {
      const avail = this.available();
      return avail.length > 0 ? avail[0].name : null;
    }
    const candidates = this.available().filter(c =>
      requiredSkills.every(s => c.skills.includes(s)),
    );
    if (candidates.length === 0) return null;
    candidates.sort((a, b) => a.runningTasks - b.runningTasks);
    return candidates[0].name;
  }

  incrementRunning(name: string): void {
    const cap = this.caps.get(name);
    if (cap) { cap.runningTasks++; this.persist(); }
  }

  decrementRunning(name: string): void {
    const cap = this.caps.get(name);
    if (cap && cap.runningTasks > 0) { cap.runningTasks--; this.persist(); }
  }

  updateLastSeen(name: string): void {
    const cap = this.caps.get(name);
    if (cap) cap.lastSeen = Date.now();
  }

  describeWorkers(): string {
    const workers = this.all();
    if (workers.length === 0) return '(无可用 Worker)';
    return workers.map(w =>
      `- ${w.name} (${w.runtime}): 擅长 ${w.skills.join(', ')} | 负载 ${w.runningTasks}/${w.maxConcurrent}`,
    ).join('\n');
  }

  private persist(): void {
    const obj: Record<string, BotCapability> = {};
    for (const [name, cap] of this.caps) obj[name] = cap;
    atomicWrite(CAP_FILE, JSON.stringify(obj, null, 2));
  }
}
