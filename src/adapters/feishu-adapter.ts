import type { InboundMessage, OutboundMessage, PreviewCapabilities, SendResult } from 'claude-to-im/src/lib/bridge/types.js';
import { BaseChannelAdapter, registerAdapterFactory } from 'claude-to-im/src/lib/bridge/channel-adapter.js';
import { getBridgeContext } from 'claude-to-im/src/lib/bridge/context.js';
import { FeishuAdapter as UpstreamFeishuAdapter } from 'claude-to-im/src/lib/bridge/adapters/feishu-adapter.js';
import { getFeishuPairingStore } from '../feishu-pairing-store.js';

function parseCsv(raw: string | null): string[] {
  return (raw || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function buildTextMessage(address: InboundMessage['address'], text: string): OutboundMessage {
  return {
    address,
    text,
    parseMode: 'plain',
  };
}

export class FeishuPairingAdapter extends BaseChannelAdapter {
  readonly channelType = 'feishu' as const;
  private readonly inner = new UpstreamFeishuAdapter();
  private readonly pairingStore = getFeishuPairingStore();

  async start(): Promise<void> {
    await this.inner.start();
  }

  async stop(): Promise<void> {
    await this.inner.stop();
  }

  isRunning(): boolean {
    return this.inner.isRunning();
  }

  async consumeOne(): Promise<InboundMessage | null> {
    while (this.inner.isRunning()) {
      const message = await this.inner.consumeOne();
      if (!message) return null;

      if (!this.isPairingEnabled()) {
        return message;
      }

      if (message.callbackData) {
        return message;
      }

      const text = message.text.trim();
      const userId = message.address.userId || '';

      if (!userId) {
        return message;
      }

      if (this.isAdminUser(userId) && await this.handleAdminCommand(message, text)) {
        continue;
      }

      if (this.isApprovedUser(userId)) {
        return message;
      }

      await this.handlePendingUserMessage(message);
      continue;
    }

    return null;
  }

  async send(message: OutboundMessage): Promise<SendResult> {
    return this.inner.send(message);
  }

  async answerCallback(callbackQueryId: string, text?: string): Promise<void> {
    await this.inner.answerCallback(callbackQueryId, text);
  }

  validateConfig(): string | null {
    return this.inner.validateConfig();
  }

  isAuthorized(userId: string, chatId: string): boolean {
    return this.inner.isAuthorized(userId, chatId);
  }

  onMessageStart(chatId: string): void {
    this.inner.onMessageStart?.(chatId);
  }

  editMessage(messageId: string, text: string): Promise<boolean> {
    return this.inner.editMessage ? this.inner.editMessage(messageId, text) : Promise.resolve(false);
  }

  onMessageEnd(chatId: string): void {
    this.inner.onMessageEnd?.(chatId);
  }

  acknowledgeUpdate(updateId: number): void {
    this.inner.acknowledgeUpdate?.(updateId);
  }

  getPreviewCapabilities(chatId: string): PreviewCapabilities | null {
    return this.inner.getPreviewCapabilities ? this.inner.getPreviewCapabilities(chatId) : null;
  }

  sendPreview(chatId: string, text: string, draftId: number): Promise<'sent' | 'skip' | 'degrade'> {
    return this.inner.sendPreview ? this.inner.sendPreview(chatId, text, draftId) : Promise.resolve('degrade');
  }

  endPreview(chatId: string, draftId: number): void {
    this.inner.endPreview?.(chatId, draftId);
  }

  onStreamText(chatId: string, fullText: string): void {
    this.inner.onStreamText?.(chatId, fullText);
  }

  onToolEvent(chatId: string, tools: import('claude-to-im/src/lib/bridge/types.js').ToolCallInfo[]): void {
    this.inner.onToolEvent?.(chatId, tools);
  }

  onStreamEnd(chatId: string, status: 'completed' | 'interrupted' | 'error', responseText: string): Promise<boolean> {
    return this.inner.onStreamEnd ? this.inner.onStreamEnd(chatId, status, responseText) : Promise.resolve(false);
  }

  private isPairingEnabled(): boolean {
    return getBridgeContext().store.getSetting('bridge_feishu_pairing_enabled') === 'true';
  }

  private requireDirectMessageOnly(): boolean {
    return getBridgeContext().store.getSetting('bridge_feishu_pairing_require_direct_message') === 'true';
  }

  private isAdminUser(userId: string): boolean {
    return parseCsv(getBridgeContext().store.getSetting('bridge_feishu_pairing_admin_users')).includes(userId);
  }

  private isAutoApprovedUser(userId: string): boolean {
    return parseCsv(getBridgeContext().store.getSetting('bridge_feishu_pairing_auto_approve_users')).includes(userId);
  }

  private isApprovedUser(userId: string): boolean {
    return this.isAdminUser(userId) || this.isAutoApprovedUser(userId) || this.pairingStore.isApproved(userId);
  }

  private async handlePendingUserMessage(message: InboundMessage): Promise<void> {
    const userId = message.address.userId || '';
    if (!userId) return;

    const record = this.pairingStore.upsertPending(
      userId,
      message.address.chatId,
      message.text.slice(0, 200),
    );

    const reply = [
      '你还没有通过配对审批，当前消息不会进入 AI 会话。',
      `配对码：${record.pairingCode}`,
      '请把这串配对码发给管理员，由管理员审批后再继续使用。',
    ].join('\n');

    await this.inner.send(buildTextMessage(message.address, reply));
  }

  private async handleAdminCommand(message: InboundMessage, text: string): Promise<boolean> {
    if (!text.startsWith('/pair')) {
      return false;
    }

    const parts = text.split(/\s+/);
    const subcommand = parts[1] || 'help';

    switch (subcommand) {
      case 'pending': {
        const pending = this.pairingStore.list('pending');
        const body = pending.length > 0
          ? pending.map((record) => `${record.pairingCode} | ${record.userId} | ${record.lastMessagePreview || ''}`).join('\n')
          : '当前没有待审批用户。';
        await this.inner.send(buildTextMessage(message.address, body));
        return true;
      }
      case 'approve': {
        const code = parts[2];
        if (!code) {
          await this.inner.send(buildTextMessage(message.address, '用法：/pair approve <CODE>'));
          return true;
        }
        const record = this.pairingStore.approveByCode(code);
        await this.inner.send(
          buildTextMessage(
            message.address,
            record
              ? `已批准 ${record.userId}，配对码 ${record.pairingCode}。`
              : `未找到配对码：${code}`,
          ),
        );
        return true;
      }
      case 'reject': {
        const code = parts[2];
        if (!code) {
          await this.inner.send(buildTextMessage(message.address, '用法：/pair reject <CODE>'));
          return true;
        }
        const record = this.pairingStore.rejectByCode(code);
        await this.inner.send(
          buildTextMessage(
            message.address,
            record
              ? `已拒绝 ${record.userId}，配对码 ${record.pairingCode}。`
              : `未找到配对码：${code}`,
          ),
        );
        return true;
      }
      case 'help':
      default:
        await this.inner.send(
          buildTextMessage(
            message.address,
            [
              '可用命令：',
              '/pair pending',
              '/pair approve <CODE>',
              '/pair reject <CODE>',
            ].join('\n'),
          ),
        );
        return true;
    }
  }
}

registerAdapterFactory('feishu', () => new FeishuPairingAdapter());
