/**
 * Multi-bot orchestrator — spawns one Worker Thread per bot,
 * routes relay messages between them via MessagePort.
 *
 * Config: reads bots.json from CTI_HOME (default ~/.claude-to-im).
 */

import fs from 'node:fs';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

interface BotEntry {
  name: string;
  ctiHome: string;
}

interface RelayMessage {
  type: 'relay';
  target: string;
  payload: {
    chatId: string;
    text: string;
    senderName: string;
    senderType: string;
    replyMessageId?: string;
  };
}

interface IdentityMessage {
  type: 'identity';
  name: string;
  openId: string;
}

type WorkerMessage = RelayMessage | IdentityMessage;

const CTI_HOME = process.env.CTI_HOME || path.join(process.env.HOME || '/root', '.claude-to-im');
const BOTS_CONFIG = path.join(CTI_HOME, 'bots.json');
const RUNTIME_DIR = path.join(CTI_HOME, 'runtime');
const STATUS_FILE = path.join(RUNTIME_DIR, 'status.json');
const PID_FILE = path.join(RUNTIME_DIR, 'bridge.pid');

function loadBots(): BotEntry[] {
  if (!fs.existsSync(BOTS_CONFIG)) {
    console.error(`[orchestrator] bots.json not found at ${BOTS_CONFIG}`);
    process.exit(1);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(BOTS_CONFIG, 'utf-8'));
  } catch (err) {
    console.error(`[orchestrator] bots.json is not valid JSON: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }
  if (!Array.isArray(raw) || raw.length === 0) {
    console.error('[orchestrator] bots.json must be a non-empty array');
    process.exit(1);
  }
  const bots: BotEntry[] = [];
  const names = new Set<string>();
  for (let i = 0; i < raw.length; i++) {
    const entry = raw[i];
    if (!entry || typeof entry.name !== 'string' || !entry.name.trim()) {
      console.error(`[orchestrator] bots.json[${i}]: missing or invalid "name" field`);
      process.exit(1);
    }
    if (typeof entry.ctiHome !== 'string' || !entry.ctiHome.trim()) {
      console.error(`[orchestrator] bots.json[${i}]: missing or invalid "ctiHome" field`);
      process.exit(1);
    }
    if (!fs.existsSync(entry.ctiHome)) {
      console.error(`[orchestrator] bots.json[${i}]: ctiHome directory does not exist: ${entry.ctiHome}`);
      process.exit(1);
    }
    const key = entry.name.trim().toLowerCase();
    if (names.has(key)) {
      console.error(`[orchestrator] bots.json: duplicate bot name "${entry.name}"`);
      process.exit(1);
    }
    names.add(key);
    bots.push({ name: entry.name.trim(), ctiHome: entry.ctiHome });
  }
  return bots;
}

function writeStatus(info: Record<string, unknown>): void {
  fs.mkdirSync(RUNTIME_DIR, { recursive: true });
  let existing: Record<string, unknown> = {};
  try { existing = JSON.parse(fs.readFileSync(STATUS_FILE, 'utf-8')); } catch { /* first write */ }
  const merged = { ...existing, ...info };
  const tmp = STATUS_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(merged, null, 2), 'utf-8');
  fs.renameSync(tmp, STATUS_FILE);
}

const workers = new Map<string, Worker>();
const workerEntryPath = path.join(__dirname, 'worker-entry.mjs');
const restartState = new Map<string, { failures: number; lastExit: number }>();

function getBackoffMs(botKey: string): number {
  const state = restartState.get(botKey);
  if (!state) return 3000;
  const delay = Math.min(3000 * Math.pow(2, state.failures - 1), 60000);
  return delay;
}

function recordExit(botKey: string): void {
  const now = Date.now();
  const state = restartState.get(botKey) || { failures: 0, lastExit: 0 };
  // Reset failure count if last exit was more than 5 minutes ago (healthy run)
  if (now - state.lastExit > 300_000) {
    state.failures = 1;
  } else {
    state.failures++;
  }
  state.lastExit = now;
  restartState.set(botKey, state);
}

function spawnWorker(bot: BotEntry): Worker {
  const w = new Worker(workerEntryPath, {
    workerData: { ctiHome: bot.ctiHome, botName: bot.name },
  });

  w.on('message', (msg: WorkerMessage) => {
    if (msg.type === 'relay') {
      const target = workers.get(msg.target.toLowerCase());
      const correlationId = (msg as any).correlationId;
      if (target) {
        target.postMessage(msg);
        if (correlationId) w.postMessage({ type: 'relay-ack', correlationId });
      } else {
        console.warn(`[orchestrator] Relay target not found: ${msg.target}`);
        if (correlationId) w.postMessage({ type: 'relay-nack', correlationId });
      }
    } else if (msg.type === 'identity') {
      for (const [name, worker] of workers) {
        if (name !== bot.name.toLowerCase()) {
          worker.postMessage(msg);
        }
      }
    }
  });

  w.on('error', (err) => {
    console.error(`[orchestrator] Worker ${bot.name} error:`, err.message);
  });

  w.on('exit', (code) => {
    console.warn(`[orchestrator] Worker ${bot.name} exited (code: ${code})`);
    workers.delete(bot.name.toLowerCase());

    // Notify remaining workers to clear stale identity for this bot
    for (const [, worker] of workers) {
      worker.postMessage({ type: 'peer-reset', name: bot.name });
    }

    if (!shuttingDown) {
      const botKey = bot.name.toLowerCase();
      recordExit(botKey);
      const delay = getBackoffMs(botKey);
      console.log(`[orchestrator] Restarting ${bot.name} in ${delay}ms...`);
      setTimeout(() => {
        if (!shuttingDown) {
          const newWorker = spawnWorker(bot);
          workers.set(botKey, newWorker);
        }
      }, delay);
    }
  });

  return w;
}

let shuttingDown = false;

async function shutdown(signal?: string, exitCode = 0): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  const reason = signal ? `signal: ${signal}` : 'shutdown requested';
  console.log(`[orchestrator] Shutting down (${reason})...`);

  const terminatePromises = Array.from(workers.values()).map(w =>
    w.terminate().catch(() => {})
  );
  await Promise.allSettled(terminatePromises);

  writeStatus({ running: false, lastExitReason: reason });
  process.exit(exitCode);
}

function main(): void {
  const bots = loadBots();

  fs.mkdirSync(RUNTIME_DIR, { recursive: true });
  fs.writeFileSync(PID_FILE, String(process.pid), 'utf-8');
  writeStatus({
    running: true,
    pid: process.pid,
    mode: 'orchestrator',
    startedAt: new Date().toISOString(),
    bots: bots.map(b => b.name),
  });

  console.log(`[orchestrator] Starting ${bots.length} bot(s): ${bots.map(b => b.name).join(', ')}`);

  for (const bot of bots) {
    const w = spawnWorker(bot);
    workers.set(bot.name.toLowerCase(), w);
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGHUP', () => shutdown('SIGHUP'));

  process.on('uncaughtException', (err) => {
    console.error('[orchestrator] uncaughtException:', err.stack || err.message);
    // Attempt graceful shutdown with a hard deadline — event loop may be damaged
    const forceTimer = setTimeout(() => process.exit(1), 3000);
    forceTimer.unref();
    shutdown(`uncaughtException: ${err.message}`, 1);
  });

  setInterval(() => { /* keepalive */ }, 45_000);
}

main();
