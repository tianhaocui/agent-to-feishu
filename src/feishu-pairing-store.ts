import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';

import { CTI_HOME } from './config.js';

export type PairingStatus = 'pending' | 'approved' | 'rejected';

export interface PairingRecord {
  userId: string;
  latestChatId: string;
  status: PairingStatus;
  pairingCode: string;
  firstRequestedAt: string;
  lastRequestedAt: string;
  approvedAt?: string;
  rejectedAt?: string;
  lastMessagePreview?: string;
}

interface PairingFileShape {
  version: number;
  users: Record<string, PairingRecord>;
}

const PAIRING_FILE = path.join(CTI_HOME, 'data', 'feishu-pairings.json');
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function nowIso(): string {
  return new Date().toISOString();
}

function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

function atomicWrite(filePath: string, data: string): void {
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, data, 'utf-8');
  fs.renameSync(tmp, filePath);
}

function readFileData(): PairingFileShape {
  ensureDir(path.dirname(PAIRING_FILE));
  try {
    return JSON.parse(fs.readFileSync(PAIRING_FILE, 'utf-8')) as PairingFileShape;
  } catch {
    const initial: PairingFileShape = { version: 1, users: {} };
    atomicWrite(PAIRING_FILE, JSON.stringify(initial, null, 2));
    return initial;
  }
}

function writeFileData(data: PairingFileShape): void {
  ensureDir(path.dirname(PAIRING_FILE));
  atomicWrite(PAIRING_FILE, JSON.stringify(data, null, 2));
}

function generateCode(): string {
  let out = '';
  for (let i = 0; i < 6; i += 1) {
    out += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
  }
  return out;
}

export interface UpsertResult {
  record: PairingRecord;
  isNew: boolean;
}

export class FeishuPairingStore {
  private data: PairingFileShape;

  constructor() {
    this.data = readFileData();
  }

  private persist(): void {
    writeFileData(this.data);
  }

  get(userId: string): PairingRecord | null {
    return this.data.users[userId] ?? null;
  }

  isApproved(userId: string): boolean {
    return this.get(userId)?.status === 'approved';
  }

  upsertPending(userId: string, chatId: string, messagePreview: string): UpsertResult {
    const existing = this.data.users[userId];
    const isNew = !existing || existing.status !== 'pending';
    const timestamp = nowIso();
    const record: PairingRecord = {
      userId,
      latestChatId: chatId,
      status: existing?.status === 'approved' ? 'approved' : 'pending',
      pairingCode: existing?.pairingCode || generateCode(),
      firstRequestedAt: existing?.firstRequestedAt || timestamp,
      lastRequestedAt: timestamp,
      approvedAt: existing?.approvedAt,
      rejectedAt: undefined,
      lastMessagePreview: messagePreview,
    };

    if (record.status !== 'approved') {
      record.status = 'pending';
      record.approvedAt = undefined;
    }

    this.data.users[userId] = record;
    this.persist();
    return { record, isNew };
  }

  approveByCode(code: string): PairingRecord | null {
    const normalized = code.trim().toUpperCase();
    const entry = Object.entries(this.data.users).find(([, record]) => record.pairingCode === normalized);
    if (!entry) return null;

    const [userId, record] = entry;
    const updated: PairingRecord = {
      ...record,
      status: 'approved',
      approvedAt: nowIso(),
      rejectedAt: undefined,
    };
    this.data.users[userId] = updated;
    this.persist();
    return updated;
  }

  rejectByCode(code: string): PairingRecord | null {
    const normalized = code.trim().toUpperCase();
    const entry = Object.entries(this.data.users).find(([, record]) => record.pairingCode === normalized);
    if (!entry) return null;

    const [userId, record] = entry;
    const updated: PairingRecord = {
      ...record,
      status: 'rejected',
      rejectedAt: nowIso(),
    };
    this.data.users[userId] = updated;
    this.persist();
    return updated;
  }

  list(status?: PairingStatus): PairingRecord[] {
    const records = Object.values(this.data.users).sort((a, b) =>
      a.firstRequestedAt.localeCompare(b.firstRequestedAt)
    );
    return status ? records.filter((record) => record.status === status) : records;
  }
}

export function getFeishuPairingStore(): FeishuPairingStore {
  return new FeishuPairingStore();
}
