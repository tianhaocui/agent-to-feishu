# Agent-to-Feishu

将 AI 编程代理（Claude Code / Codex）桥接到飞书 — 直接在飞书中与 AI 代理对话。

[English](README.md)

## 工作原理

```
飞书机器人 (WebSocket 长连接)
  ↕
桥接守护进程 (Node.js)
  ↕ Claude Agent SDK / Codex SDK
Claude Code / Codex → 读写你的代码库
```

守护进程通过 WebSocket 连接飞书（无需公网 IP），接收消息，转发给 AI 代理，并以流式卡片回传响应。

## 功能

- **飞书原生体验** — WebSocket 长连接、CardKit v1 流式卡片、交互按钮
- **实时流式输出** — AI 响应以打字机效果流入飞书卡片
- **思考过程展示** — extended thinking 实时显示，最终卡片中可折叠查看
- **工具进度** — 运行中的工具显示耗时（`🔄 Bash (15s)`），每 5 秒自动刷新
- **权限控制** — 工具调用需通过卡片按钮或快捷 `1/2/3` 回复审批
- **配对审批** — 未知用户获得配对码，管理员通过交互卡片按钮审批
- **斜杠命令** — `/ask`、`/run`、`/code` 转发给 AI；未知命令默认也转发
- **双运行时** — Claude Code CLI 或 Codex SDK，通过配置切换
- **会话持久化** — 对话在守护进程重启后保留，自动恢复会话

## 前置要求

- Node.js >= 20
- Claude Code CLI（已认证）或 Codex SDK
- 飞书自建应用（需开启机器人能力）

## 配置

### 1. 创建飞书应用

1. 前往[飞书开放平台](https://open.feishu.cn/app)
2. 创建自建应用 → 获取 App ID 和 App Secret
3. 添加机器人能力
4. 添加权限：`im:message`、`im:message:send_as_bot`、`im:resource`、`im:message.reactions:write_as_bot`
5. 事件订阅：选择**长连接** → 添加 `im.message.receive_v1`
6. 发布版本并审核通过

### 2. 编辑配置

```bash
cp config.env.example ~/.claude-to-im/config.env
# 编辑填入 App ID、App Secret 等
```

关键配置：

```env
CTI_RUNTIME=claude              # claude | codex | auto
CTI_ENABLED_CHANNELS=feishu
CTI_DEFAULT_WORKDIR=/path/to/project
CTI_FEISHU_APP_ID=cli_xxx
CTI_FEISHU_APP_SECRET=xxx
CTI_FEISHU_DOMAIN=feishu.cn
```

### 3. 构建并启动

```bash
npm install
npm run build
CTI_HOME=~/.claude-to-im bash scripts/daemon.sh start
```

### 4. 开始聊天

在飞书中给机器人发消息，AI 代理通过流式卡片回复。

## 聊天命令

在飞书聊天中可用的命令：

| 命令 | 说明 |
|---|---|
| `/ask <消息>` | 向 AI 提问 |
| `/run <描述>` | 让 AI 执行命令 |
| `/code <任务>` | 让 AI 写代码 |
| `/new [路径]` | 新建会话 |
| `/stop` | 停止当前任务 |
| `/status` | 查看会话状态 |
| `/mode plan\|code\|ask` | 切换模式 |
| `/cwd /路径` | 切换工作目录 |
| `/help` | 显示所有命令 |
| `1` / `2` / `3` | 快捷权限回复（允许 / 允许本次会话 / 拒绝） |

未识别的 `/命令` 默认转发给 AI（可通过 `CTI_FORWARD_UNKNOWN_COMMANDS=false` 关闭）。

## 配对审批

当 `CTI_FEISHU_PAIRING_ENABLED=true` 时，未知用户无法直接使用 AI：

1. 用户发消息 → 收到配对码
2. 管理员收到交互审批卡片（需配置 `CTI_FEISHU_PAIRING_ADMIN_CHAT_ID`）
3. 管理员点击卡片上的 批准/拒绝 按钮，或使用 `/pair approve <CODE>`
4. 审批通过后用户即可正常对话

配置：

```env
CTI_FEISHU_PAIRING_ENABLED=true
CTI_FEISHU_PAIRING_ADMIN_USERS=ou_admin1,ou_admin2
CTI_FEISHU_PAIRING_ADMIN_CHAT_ID=oc_xxx   # 审批卡片发送到的管理员群
CTI_FEISHU_PAIRING_AUTO_APPROVE_USERS=ou_owner1
```

## 权限流程

```
1. AI 想使用工具（如编辑文件）
2. 桥接发送权限卡片，带 允许 / 允许本次会话 / 拒绝 按钮
3. 用户点击按钮或回复 1/2/3
4. AI 继续执行 → 结果流式回传到飞书卡片
5. 超时：5 分钟 → 自动拒绝
```

## 架构

```
~/.claude-to-im/
├── config.env             ← 凭据与配置 (chmod 600)
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

| 组件 | 职责 |
|---|---|
| `src/main.ts` | 守护进程入口，依赖注入组装 |
| `src/llm-provider.ts` | Claude Agent SDK → SSE 流（支持 thinking） |
| `src/codex-provider.ts` | Codex SDK → SSE 流 |
| `src/adapters/feishu-adapter.ts` | 配对审批门禁 + 审批卡片 |
| `src/permission-gateway.ts` | 异步桥接：SDK canUseTool ↔ IM 按钮 |
| `vendor/Claude-to-IM/` | 核心桥接库（适配器、流式、投递） |

## 守护进程管理

```bash
CTI_HOME=~/.claude-to-im bash scripts/daemon.sh start    # 启动
CTI_HOME=~/.claude-to-im bash scripts/daemon.sh stop     # 停止
CTI_HOME=~/.claude-to-im bash scripts/daemon.sh status   # 状态
CTI_HOME=~/.claude-to-im bash scripts/daemon.sh logs 50  # 最近日志
bash scripts/doctor.sh                                     # 诊断
```

## 开发

```bash
npm install
npm run build      # 构建
npm run typecheck   # 类型检查
npm test           # 运行测试
npm run dev        # 开发模式
npm run pairing -- list pending    # CLI 配对管理
```

## 许可

[MIT](LICENSE)
