---
name: agent-to-feishu
description: |
  Bridge THIS Claude Code or Codex session to Feishu/Lark so the user can chat
  with the AI agent from Feishu. Use for: setting up, starting, stopping, or
  diagnosing the agent-to-feishu bridge daemon.
  Trigger phrases: "agent-to-feishu", "bridge", "桥接", "连上飞书",
  "手机上看claude", "启动后台服务", "诊断", "查看日志", "配置".
  Subcommands: setup, start, stop, status, logs, reconfigure, doctor.
  Do NOT use for: building standalone bots, webhook integrations, or coding with
  Feishu SDK — those are regular programming tasks.
argument-hint: "setup | start | stop | status | logs [N] | reconfigure | doctor"
allowed-tools:
  - Bash
  - Read
  - Write
  - Edit
  - AskUserQuestion
  - Grep
  - Glob
---

# Agent-to-Feishu Bridge Skill

You are managing the Agent-to-Feishu bridge — a Feishu-only distillation of claude-to-im.
User data is stored at `~/.claude-to-im/`.

The skill directory (SKILL_DIR) is at `~/.claude/skills/agent-to-feishu`.
If that path doesn't exist, fall back to Glob with pattern `**/skills/**/agent-to-feishu/SKILL.md` and derive the root from the result.

## Command parsing

Parse the user's intent from `$ARGUMENTS` into one of these subcommands:

| User says (examples) | Subcommand |
|---|---|
| `setup`, `configure`, `配置`, `我想在飞书上用 Claude` | setup |
| `start`, `启动`, `启动桥接` | start |
| `stop`, `停止`, `停止桥接` | stop |
| `status`, `状态`, `运行状态` | status |
| `logs`, `logs 200`, `查看日志` | logs |
| `reconfigure`, `修改配置`, `帮我改一下 token` | reconfigure |
| `doctor`, `diagnose`, `诊断`, `挂了`, `没反应了` | doctor |

**Disambiguation: `status` vs `doctor`** — Use `status` for informational checks. Use `doctor` when the user reports a problem. When in doubt and the user describes a symptom (e.g., "没反应了", "挂了"), prefer `doctor`.

Extract optional numeric argument for `logs` (default 50).

Before asking for credentials, read `SKILL_DIR/references/setup-guides.md` internally. Do NOT dump the full guide upfront — only mention the specific next step.

## Runtime detection

Before executing any subcommand:

1. **Claude Code** — `AskUserQuestion` tool is available. Use it for interactive setup.
2. **Codex / other** — `AskUserQuestion` is NOT available. Show `SKILL_DIR/config.env.example` and ask the user to create `~/.claude-to-im/config.env` manually.

## Config check (applies to all subcommands except `setup`)

Check if `~/.claude-to-im/config.env` exists:

- **Missing:** In Claude Code, auto-start `setup`. In Codex, show the example config and stop.
- **Exists:** proceed with the requested subcommand.

## Subcommands

### `setup`

Interactive setup wizard (requires `AskUserQuestion`). Collect input **one field at a time**, confirming each value (secrets masked to last 4 chars).

**Step 1 — Feishu credentials**

Collect one at a time:
1. App ID → confirm
2. App Secret → confirm (masked)
3. Domain (optional, default `https://open.feishu.cn`)
4. Allowed User IDs (optional)

After collecting, explain the two-phase Feishu setup:
- **Phase 1** (before starting bridge): batch-add permissions, enable bot capability, publish + admin approve.
- **Phase 2** (requires running bridge): start bridge, configure events (`im.message.receive_v1`) and callback (`card.action.trigger`) with long connection mode, publish again + admin approve.
- **Why two phases:** Feishu validates WebSocket on save — bridge must be running for event subscription to succeed.

**Step 2 — General settings**

- **Runtime**: `claude` (default), `codex`, `auto`
- **Working Directory**: default `$CWD`
- **Model** (optional): leave blank for runtime default
- **Mode**: `code` (default), `plan`, `ask`

**Step 3 — Optional features**

- **Pairing approval** (`CTI_FEISHU_PAIRING_ENABLED`): gate unknown users behind admin approval
  - Admin users, auto-approve users, admin chat ID for approval cards
- **Multi-bot collaboration** (`CTI_FEISHU_MULTI_BOT_ENABLED`): multiple AI bots in group chats
  - Known bots (`CTI_FEISHU_KNOWN_BOTS=Name:open_id,...`)
- **Auto-approve** (`CTI_AUTO_APPROVE`): skip tool permission prompts (trusted environments only)
- **Permission timeout** (`CTI_PERMISSION_TIMEOUT_SECS`): default 300 seconds

**Step 4 — Write config and validate**

1. Show summary table (secrets masked)
2. Confirm before writing
3. `mkdir -p ~/.claude-to-im/{data,logs,runtime,data/messages}`
4. Write `~/.claude-to-im/config.env` (KEY=VALUE format)
5. `chmod 600 ~/.claude-to-im/config.env`
6. Validate tokens — read `SKILL_DIR/references/token-validation.md` for Feishu validation commands
7. On success: "Setup complete! Run `/agent-to-feishu start` to start the bridge."

### `start`

**Pre-check:** config.env must exist (see above).

Run: `bash "SKILL_DIR/scripts/daemon.sh" start`

If it fails, suggest `/agent-to-feishu doctor` and `/agent-to-feishu logs`.

### `stop`

Run: `bash "SKILL_DIR/scripts/daemon.sh" stop`

### `status`

Run: `bash "SKILL_DIR/scripts/daemon.sh" status`

### `logs`

Extract optional line count N (default 50).
Run: `bash "SKILL_DIR/scripts/daemon.sh" logs N`

### `reconfigure`

1. Read and display current config (secrets masked)
2. Ask what to change via AskUserQuestion
3. Update config atomically (write tmp, rename)
4. Re-validate changed tokens
5. Remind: "Run `/agent-to-feishu stop` then `/agent-to-feishu start` to apply."

### `doctor`

Run: `bash "SKILL_DIR/scripts/doctor.sh"`

Common fixes:
- SDK cli.js missing → `cd SKILL_DIR && npm install`
- dist/daemon.mjs stale → `cd SKILL_DIR && npm run build`
- Config missing → run `setup`

For complex issues, read `SKILL_DIR/references/troubleshooting.md`.

**Feishu upgrade note:** If Feishu returns permission errors after upgrading, the user likely needs to add new scopes (`cardkit:card:write`, `cardkit:card:read`, `im:message:update`, `im:message.reactions:read`, `im:message.reactions:write_only`), add the `card.action.trigger` callback, and re-publish. See `SKILL_DIR/references/setup-guides.md`.

## Notes

- Always mask secrets in output (last 4 chars only).
- Always check config.env before starting — without it the daemon crashes and leaves a stale PID.
- The daemon runs as a background Node.js process (launchd on macOS, setsid on Linux).
- Config persists at `~/.claude-to-im/config.env`.
