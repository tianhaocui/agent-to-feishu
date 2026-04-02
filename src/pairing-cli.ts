import { getFeishuPairingStore } from './feishu-pairing-store.js';

const store = getFeishuPairingStore();

function printUsage(): void {
  console.log('Usage:');
  console.log('  npm run pairing -- list [pending|approved|rejected]');
  console.log('  npm run pairing -- approve <CODE>');
  console.log('  npm run pairing -- reject <CODE>');
}

function printRecords(records: ReturnType<typeof store.list>): void {
  if (records.length === 0) {
    console.log('No pairing records found.');
    return;
  }

  for (const record of records) {
    console.log(
      [
        `userId=${record.userId}`,
        `chatId=${record.latestChatId}`,
        `status=${record.status}`,
        `code=${record.pairingCode}`,
        `firstRequestedAt=${record.firstRequestedAt}`,
        `approvedAt=${record.approvedAt || '-'}`,
        `lastMessage=${JSON.stringify(record.lastMessagePreview || '')}`,
      ].join(' | '),
    );
  }
}

const command = process.argv[2] || 'list';

switch (command) {
  case 'list':
    printRecords(store.list(process.argv[3] as 'pending' | 'approved' | 'rejected' | undefined));
    break;
  case 'approve': {
    const code = process.argv[3];
    if (!code) {
      printUsage();
      process.exit(1);
    }
    const record = store.approveByCode(code);
    if (!record) {
      console.error(`Pairing code not found: ${code}`);
      process.exit(1);
    }
    console.log(`Approved ${record.userId} (${record.pairingCode}).`);
    break;
  }
  case 'reject': {
    const code = process.argv[3];
    if (!code) {
      printUsage();
      process.exit(1);
    }
    const record = store.rejectByCode(code);
    if (!record) {
      console.error(`Pairing code not found: ${code}`);
      process.exit(1);
    }
    console.log(`Rejected ${record.userId} (${record.pairingCode}).`);
    break;
  }
  default:
    printUsage();
    process.exit(1);
}
