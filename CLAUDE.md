# CLAUDE.md — Project Guidelines for agent-to-feishu

## Overview

This is a Feishu-specific bridge that connects AI coding agents (Claude Code / Codex) to Feishu via WebSocket long connection. It is a fork of `claude-to-im` focused exclusively on Feishu.

## Architecture

- `src/` — host application (main, config, store, LLM providers, pairing adapter)
- `vendor/Claude-to-IM/` — vendored core bridge library (adapters, streaming, delivery, card builders)
- After modifying vendor source, rebuild with: `cd vendor/Claude-to-IM && npm run build`
- Then rebuild main: `npm run build`

## Key Design Decisions

- Feishu adapter uses WSClient long connection (no webhook/public IP needed)
- CardKit v1 streaming cards for real-time AI response display
- Pairing approval gate in `src/adapters/feishu-adapter.ts` wraps the upstream adapter
- Permission cards use `card.action.trigger` callbacks via monkey-patched WSClient
- Slash commands `/ask`, `/run`, `/code` forward to AI CLI; unknown commands also forwarded by default
- Thinking/reasoning events from Claude SDK are streamed in real-time to cards

## Build & Run

```bash
npm install
npm run build
CTI_HOME=~/.claude-to-im bash scripts/daemon.sh start
```

## Config

All config in `~/.claude-to-im/config.env`. See `config.env.example` for all options.

## 飞书文档操作

使用 lark-mcp 创建飞书文档（`docx_builtin_import`、`bitable_v1_app_create` 等）时，必须传 `useUAT: true` 以用户身份创建，确保文档归属于用户而非 bot 应用。读取操作也建议使用 `useUAT: true`，可以访问用户有权限但 bot 无权限的文档。
