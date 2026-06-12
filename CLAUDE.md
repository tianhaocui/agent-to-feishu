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

## 记忆维护规则

每轮对话中，主动检查是否有值得存入 memory 的内容。发现即存，不要等会话结束。

**必须存的情况：**
- 用户做了产品/技术决策（选了方案 A 而不是 B） → `project` 类型
- 用户纠正了你的做法，或确认了你的非常规做法有效 → `feedback` 类型
- 了解到用户的角色、偏好、知识背景 → `user` 类型
- 提到外部系统、文档链接、第三方服务的位置 → `reference` 类型

**不要存的：**
- 代码结构、文件路径（读代码就能知道）
- Git 历史（git log 就有）
- 本次对话的临时任务状态（用 Task 工具）
- CLAUDE.md 里已经写了的内容

**格式要求：**
- 一条记忆一个文件，写入 `~/.claude/projects/-root-agent-to-feishu/memory/`
- 文件名用 `{type}_{topic}.md` 格式（如 `project_relay_auth_decision.md`）
- 更新 MEMORY.md 索引
- 多 bot 共享同一个 memory 目录，注意不要覆盖别人写的记忆

## 飞书文档操作

使用 lark-mcp 创建飞书文档（`docx_builtin_import`、`bitable_v1_app_create` 等）时，必须传 `useUAT: true` 以用户身份创建，确保文档归属于用户而非 bot 应用。读取操作也建议使用 `useUAT: true`，可以访问用户有权限但 bot 无权限的文档。
