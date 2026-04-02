# Agent-to-Feishu

Bridge AI coding agents (Claude Code / Codex) to Feishu — chat with your AI agent directly from Feishu.

[中文文档](README_CN.md)

## How It Works

```
Feishu Bot (WebSocket long connection)
  ↕
Bridge Daemon (Node.js)
  ↕ Claude Agent SDK / Codex SDK
Claude Code / Codex → reads/writes your codebase
```

The daemon connects to Feishu via WebSocket (no public IP needed), receives messages, forwards them to the AI agent, and streams responses back as interactive cards.

## Features

- **Feishu-native** — WebSocket long connection, CardKit v1 streaming cards, interactive buttons
- **Real-time streaming** — AI responses stream into Feishu cards with typewriter effect
- **Thinking display** — extended thinking content shown in real-time, collapsed in final card
- **Tool progress** — running tools show elapsed time (`🔄 Bash (15s)`), auto-refreshed every 5s
- **Permission control** — tool calls require approval via card buttons or quick `1/2/3` replies
- **Pairing approval** — unknown users get a pairing code; admins approve via interactive card buttons
- **Slash commands** — `/ask`, `/run`, `/code` forward to AI; unknown commands also forwarded by default
- **Dual runtime** — Claude Code CLI or Codex SDK, switchable via config
- **Session persistence** — conversations survive daemon restarts with automatic session resume

## Prerequisites

- Node.js >= 20
- Claude Code CLI (authenticated) or Codex SDK
- A Feishu custom app with Bot capability

## Setup

### 1. Create Feishu App

1. Go to [Feishu Open Platform](https://open.feishu.cn/app)
2. Create Custom App → get App ID and App Secret
3. Add Bot capability
4. Add permissions: `im:message`, `im:message:send_as_bot`, `im:resource`, `im:message.reactions:write_as_bot`
5. Events: select **Long Connection** → add `im.message.receive_v1`
6. Publish and approve the version

### 2. Configure

```bash
cp config.env.example ~/.claude-to-im/config.env
# Edit with your App ID, App Secret, and preferences
```

Key settings:

```env
CTI_RUNTIME=claude              # claude | codex | auto
CTI_ENABLED_CHANNELS=feishu
CTI_DEFAULT_WORKDIR=/path/to/project
CTI_FEISHU_APP_ID=cli_xxx
CTI_FEISHU_APP_SECRET=xxx
CTI_FEISHU_DOMAIN=feishu.cn
```

### 3. Build & Start

```bash
npm install
npm run build
CTI_HOME=~/.claude-to-im bash scripts/daemon.sh start
```

### 4. Chat

Send a message to your bot in Feishu. The AI agent responds through streaming cards.

## IM Commands

Commands available inside Feishu chat:

| Command | Description |
|---|---|
| `/ask <message>` | Ask AI a question |
| `/run <description>` | Ask AI to run a command |
| `/code <task>` | Ask AI to write code |
| `/new [path]` | Start new session |
| `/stop` | Stop current task |
| `/status` | Show session status |
| `/mode plan\|code\|ask` | Change mode |
| `/cwd /path` | Change working directory |
| `/help` | Show all commands |
| `1` / `2` / `3` | Quick permission reply (Allow / Allow Session / Deny) |

Unknown `/commands` are forwarded to the AI by default (configurable via `CTI_FORWARD_UNKNOWN_COMMANDS`).

## Pairing Approval

When `CTI_FEISHU_PAIRING_ENABLED=true`, unknown users cannot access the AI until approved:

1. User sends a message → receives a pairing code
2. Admin receives an interactive approval card (if `CTI_FEISHU_PAIRING_ADMIN_CHAT_ID` is set)
3. Admin clicks Approve/Reject on the card, or uses `/pair approve <CODE>`
4. Approved users can chat normally

Config:

```env
CTI_FEISHU_PAIRING_ENABLED=true
CTI_FEISHU_PAIRING_ADMIN_USERS=ou_admin1,ou_admin2
CTI_FEISHU_PAIRING_ADMIN_CHAT_ID=oc_xxx   # admin group for approval cards
CTI_FEISHU_PAIRING_AUTO_APPROVE_USERS=ou_owner1
```

## Permission Flow

```
1. AI wants to use a tool (e.g., Edit file)
2. Bridge sends a permission card with Allow / Allow Session / Deny buttons
3. User taps a button or replies 1/2/3
4. AI continues execution → result streams back to Feishu card
5. Timeout: 5 minutes → auto-deny
```

## Architecture

```
~/.claude-to-im/
├── config.env             ← Credentials & settings (chmod 600)
├── data/
│   ├── sessions.json
│   ├── bindings.json
│   ├── feishu-pairings.json
│   └── messages/
├── logs/
│   └── bridge.log
└── runtime/
    ├── bridge.pid
    └── status.json
```

| Component | Role |
|---|---|
| `src/main.ts` | Daemon entry, DI assembly |
| `src/llm-provider.ts` | Claude Agent SDK → SSE stream (with thinking support) |
| `src/codex-provider.ts` | Codex SDK → SSE stream |
| `src/adapters/feishu-adapter.ts` | Pairing gate + approval cards |
| `src/permission-gateway.ts` | Async bridge: SDK canUseTool ↔ IM buttons |
| `vendor/Claude-to-IM/` | Core bridge library (adapters, streaming, delivery) |

## Daemon Management

```bash
CTI_HOME=~/.claude-to-im bash scripts/daemon.sh start    # Start
CTI_HOME=~/.claude-to-im bash scripts/daemon.sh stop     # Stop
CTI_HOME=~/.claude-to-im bash scripts/daemon.sh status   # Status
CTI_HOME=~/.claude-to-im bash scripts/daemon.sh logs 50  # Recent logs
bash scripts/doctor.sh                                     # Diagnostics
```

## Development

```bash
npm install
npm run build      # Build bundle
npm run typecheck   # Type check
npm test           # Run tests
npm run dev        # Dev mode
npm run pairing -- list pending    # CLI pairing management
```

## License

[MIT](LICENSE)
