# Partyline 主源调研

访问日期：2026-08-23。范围：只使用官方仓库、官方文档、协议规范或一手源码；未使用二手文章。结论面向一个未来 npm 包的最小跨本地 coding agent 通信协议，不包含代码实现。

## 结论摘要

Embassy 是一个本地、单用户、同 OS 账号的消息 broker，不是通用 agent runtime。它的价值在于把不同 agent 的“已经存在的入口”接到一个有显式配对、排队、回执和仪表盘的本地控制面上；它的风险也来自这里：Claude 和 Codex 的关键接入都依赖产品内部或实验性边界，而不是一个跨厂商稳定标准。

对 Partyline 来说，最小方案不应复刻 Embassy 的内部适配器。更稳的包形态是：核心只做本地 mailbox、显式配对、消息/回执状态；对外优先暴露 MCP stdio server，因为 Codex、Claude Code、Kimi Code 都有官方 MCP 入口；同时提供一个 JSONL/CLI fallback 给 Pi 和 shell harness。暂不做远程联邦、浏览器仪表盘、agent 编排、自动审批、工作树管理。

## 1. Embassy 的真实架构、协议、运行方式、许可证与限制

### 架构

Embassy 的官方 README 描述它是 “Claude Code sessions、Codex desktop tasks、local DeepSeek Harness、Grok Build agent、shell harnesses” 之间的本地 broker；不处理 API key、不提供云 relay，并声明是非官方社区项目，未获 Anthropic/OpenAI 背书。[README](https://github.com/YuanpingSong/embassy/blob/main/README.md)（访问：2026-08-23）

官方架构文档把当前状态写得更具体：本地双向路由已实现给 Claude、Codex、DeepSeek、Grok、universal shell peers；配置的 Embassy nodes 可通过固定 attach-only SSH transport 联邦 allowlisted named routes；发布包支持 macOS，端到端只验证过 macOS。[GATEWAY-ARCHITECTURE.md](https://github.com/YuanpingSong/embassy/blob/main/docs/GATEWAY-ARCHITECTURE.md)（访问：2026-08-23）

源码结构也吻合这个分层：`src/gateway/claude-peer.ts`、`codex-app-server.ts`、`codex-local-transport.ts`、`acp-provider.ts`、`peer-stdio.ts`、`store.ts`、`control.ts`、`service.ts`、`live-dashboard-*` 等分别对应 provider adapter、控制协议、持久状态和仪表盘。[源码树](https://github.com/YuanpingSong/embassy/tree/main/src/gateway)（访问：2026-08-23）

### 协议和数据面

Embassy 的控制面是本地私有 Unix-domain socket 上的 thin CLI/control protocol；消息体进入 provider 前会包成一个 broker-owned `<cross-session-message>` 文本帧，并带 `<embassy-reply-hint>`，其中包含 conversation token、reply-as alias 和 `embassy reply` 命令。[DELIVERY.md](https://github.com/YuanpingSong/embassy/blob/main/docs/DELIVERY.md)（访问：2026-08-23）

Claude 侧实际用 Claude Code 的 peer protocol 1 和 live-session registry；源码中 `CLAUDE_PEER_COMPATIBILITY = { peerProtocol: 1 }`，并对 session UUID、alias、status、socket、PID 等做严格解析和拒绝码分类。[claude-peer.ts](https://github.com/YuanpingSong/embassy/blob/main/src/gateway/claude-peer.ts)（访问：2026-08-23）

Codex 侧使用 Codex App Server：源码通过 WebSocket-over-Duplex 连接 `ws://localhost/rpc`，调用方负责启动/边界控制 App Server proxy；文档称每次 delivery 都打开并 attested 一个 fresh managed transport、initialize、resume exact task、授权一次 body write。[codex-app-server.ts](https://github.com/YuanpingSong/embassy/blob/main/src/gateway/codex-app-server.ts)、[CONFIGURATION.md](https://github.com/YuanpingSong/embassy/blob/main/docs/CONFIGURATION.md)（访问：2026-08-23）

Universal shell peer 是 JSON-RPC 2.0 over stdin/stdout，必须先 `initialize`，然后支持 `catalog/get` 和 `handoff`，用 host/source/target 限定 direct handoff。[peer-stdio.ts](https://github.com/YuanpingSong/embassy/blob/main/src/gateway/peer-stdio.ts)（访问：2026-08-23）

### 运行方式

安装包名是 `agent-embassy`，bin 是 `embassy -> dist/src/gateway/cli.js`；`package.json` 限定 `os: ["darwin"]`、Node `>=20`，依赖很少，运行入口包括 `embassy serve`、`register-codex`、`select-claude`、`pair`、`send-to-claude`、`send-to-codex`、`reply`、`delivery-status`、`wait-delivery`、`dashboard --live` 等。[package.json](https://github.com/YuanpingSong/embassy/blob/main/package.json)、[README](https://github.com/YuanpingSong/embassy/blob/main/README.md)（访问：2026-08-23）

Codex 路线要求 managed Codex App Server standalone install，并且 README 明确说 `CODEX_APP_SERVER_USE_LOCAL_DAEMON` 是观察到可用但 OpenAI 未文档化的变量，可能变化；Claude 路线要求 live same-user Claude Code session、peer protocol 1 和目标 session 的 `crossSessionInbound`。[README](https://github.com/YuanpingSong/embassy/blob/main/README.md)、[CONFIGURATION.md](https://github.com/YuanpingSong/embassy/blob/main/docs/CONFIGURATION.md)（访问：2026-08-23）

### 许可证与限制

Embassy 仓库和 npm 包声明 MIT License。[LICENSE](https://github.com/YuanpingSong/embassy/blob/main/LICENSE)、[package.json](https://github.com/YuanpingSong/embassy/blob/main/package.json)（访问：2026-08-23）

关键限制：单用户、同机器/同账号、本地优先；不是 orchestrator；不生成 Codex sidebar task card 或 Claude UI；不绕过原生权限；delivery 的 `delivered` 只表示写到 provider 边界，不表示模型读取或执行；`ambiguous`/`unconfirmed` 不自动重放；状态和消息体有固定上限。[README](https://github.com/YuanpingSong/embassy/blob/main/README.md)、[DELIVERY.md](https://github.com/YuanpingSong/embassy/blob/main/docs/DELIVERY.md)（访问：2026-08-23）

## 2. 本地 coding agent 的官方 session / 通信 / 扩展入口

### Codex CLI / Desktop

Codex CLI 是 OpenAI 官方本地 coding agent，README 明确支持 CLI、本地 IDE extension、`codex app` 桌面体验，许可证为 Apache-2.0。[openai/codex README](https://github.com/openai/codex/blob/main/README.md)（访问：2026-08-23）

Codex App Server 是 richer clients 使用的接口，协议是 JSON-RPC 2.0；传输支持 stdio JSONL、Unix socket 上 WebSocket HTTP Upgrade，以及实验/不支持生产的 websocket listener。核心对象是 Thread、Turn、Item；主要调用包括 `thread/start`、`thread/resume`、`thread/fork`、`turn/start`、`turn/steer`、`turn/interrupt`，并用 notifications 流式输出 turn/item 事件。[app-server README](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md)（访问：2026-08-23）

Codex 也可作为 experimental MCP server：`codex mcp-server` / `codex-mcp-server`，标准 MCP over stdio，暴露 threads、turns、accounts、config、models、approvals 等；文档明确 method/field/event shape 可能变化，权威 schema 在源码 protocol types。[codex_mcp_interface.md](https://github.com/openai/codex/blob/main/codex-rs/docs/codex_mcp_interface.md)（访问：2026-08-23）

Codex 作为 MCP client 的入口是 `config.toml` 中配置 MCP servers，并可用 `codex mcp` 管理；App Server 还能通过 `selectedCapabilityRoots` 选择 plugin 或 standalone skill roots，stdio MCP server 可在对应 environment 中启动。[codex_mcp_interface.md](https://github.com/openai/codex/blob/main/codex-rs/docs/codex_mcp_interface.md)、[app-server README](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md)（访问：2026-08-23）

### Claude Code

Claude Code 官方 CLI 入口支持交互会话、`-p/--print` 非交互、`--continue/-c`、`--resume/-r`、`--output-format json|stream-json`、`--mcp-config`、`--plugin-dir`、`--permission-prompt-tool` 等。[CLI reference](https://code.claude.com/docs/en/cli-usage)（访问：2026-08-23）

官方跨 session 通信从 Claude Code v2.1.224+ 起可用（macOS/Linux；Windows 版本要求更高）：Claude 用 `ListAgents` 发现、`SendMessage` 发送；同机通过 per-session socket/named pipe，不经过 Anthropic servers；跨机器/云 session 通过 Anthropic servers/Remote Control；接收侧用 `crossSessionInbound` 控制 accept/hold/refuse，权限边界仍属于接收 session。[Cross-session messaging](https://code.claude.com/docs/en/cross-session-messaging)（访问：2026-08-23）

Claude Code 官方还提供 Agent SDK / CLI SDK，`claude -p` 可做程序化调用并输出 JSON/stream-json；TypeScript SDK 包含在 `@anthropic-ai/claude-code`。MCP 可通过 `claude mcp`、`.mcp.json`、`--mcp-config` 添加 stdio/SSE/HTTP servers；hooks、skills、plugins、slash commands 和 channels 都是官方扩展面。[Agent SDK](https://code.claude.com/docs/en/agent-sdk/overview)、[MCP](https://code.claude.com/docs/en/mcp)、[Hooks](https://code.claude.com/docs/en/hooks)、[Skills](https://code.claude.com/docs/en/skills)、[Plugins](https://code.claude.com/docs/en/plugins)、[Channels](https://code.claude.com/docs/en/channels)（访问：2026-08-23）

### Kimi Code

Kimi Code CLI 官方命令支持交互 `kimi`、`--session/-S` 恢复指定 session、`--continue/-c`、`--prompt/-p` 非交互、`--output-format text|stream-json`、`--skills-dir`、`--agent` / `--agent-file`、`--add-dir`、`kimi web`、`kimi acp` 等。[kimi command](https://www.kimi.com/code/docs/en/kimi-code-cli/reference/kimi-command)（访问：2026-08-23）

Session 侧，官方文档说明每次直接运行 `kimi` 创建新 session；可用 `kimi --continue`、`kimi --session <id>` 或 TUI 内 `/sessions`/`/resume` 恢复。不要手工编辑 sessions 目录。[Sessions and context](https://www.kimi.com/code/docs/en/kimi-code-cli/guides/sessions.html)（访问：2026-08-23）

通信/嵌入侧，Kimi 有两个官方强入口：`kimi acp` 使用 Agent Client Protocol，经 stdin/stdout JSON-RPC 让 IDE 驱动 session/prompt/tool approval/file IO；`kimi web` 启动本地 loopback REST API `/api/v1` 和 WebSocket `/api/v1/ws`，可创建 session、提交 prompt、订阅 `turn.started`、`assistant.delta`、`tool.call.started`、`tool.result`、`turn.ended` 等事件；API 明确是 experimental，应以运行时 `/openapi.json` 和 `/asyncapi.json` 为准。[kimi acp](https://www.kimi.com/code/docs/en/kimi-code-cli/reference/kimi-acp)、[Local Server and API](https://www.kimi.com/code/docs/en/kimi-code-cli/guides/server.html)、[Server API](https://www.kimi.com/code/docs/en/kimi-code-cli/reference/server-api.html)（访问：2026-08-23）

扩展侧，Kimi 官方支持 MCP、Agent Skills、Plugins、Agents/Sub-agents、Hooks。MCP 可通过 `kimi mcp` 或 TUI `/mcp` 管理；plugins 可包含 skills、agents、system prompt、session-start skill 和 MCP servers，并可从官方/curated/custom marketplace 安装。[MCP](https://www.kimi.com/code/docs/en/kimi-code-cli/customization/mcp.html)、[Skills](https://www.kimi.com/code/docs/en/kimi-code-cli/customization/skills.html)、[Plugins](https://www.kimi.com/code/docs/en/kimi-code-cli/customization/plugins.html)、[Hooks](https://www.kimi.com/code/docs/en/kimi-code-cli/customization/hooks.html)（访问：2026-08-23）

### Pi

Pi 官方仓库定位为 agent toolkit，包含 `@earendil-works/pi-coding-agent`、`pi-agent-core`、`pi-ai`、`pi-tui`；README 明确说 Pi 默认不内置限制文件系统/进程/网络/凭据的 permission system，默认继承启动它的用户和进程权限。[earendil-works/pi README](https://github.com/earendil-works/pi)（访问：2026-08-23）

Session 侧，Pi 自动把 sessions 存在 `~/.pi/agent/sessions/`，支持 `pi -c`、`pi -r`、`pi --no-session`、`pi --session <path|id>`、`pi --fork <path|id>`；TUI 内有 `/session`、`/tree`、`/fork`、`/clone`、`/compact` 等。[usage.md](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/usage.md)（访问：2026-08-23）

通信/嵌入侧，Pi 的官方 headless 入口是 `pi --mode rpc`，JSON objects over stdin/stdout，一行一条；输出包含 response 和 streaming events；命令包括 `prompt`、`steer`、`follow_up`、`abort`、`new_session`、`get_state`、`get_messages`、`switch_session`、`fork`、`clone`、`get_entries`、`get_tree` 等。[rpc.md](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/rpc.md)（访问：2026-08-23）

扩展侧，Pi 的日常入口包括 extensions、skills、prompt templates、themes、context files；官方 usage 明确写到：extensions 可注册 custom commands，skills 以 `/skill:name` 调用，prompt templates 以 `/templatename` 展开；并且设计原则写明 Pi 有意不内置 MCP、sub-agents、permission popups、plan mode、todos、background bash，这些可通过 extensions/packages 或外部工具实现。[usage.md](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/usage.md)、[extensions.md](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md)（访问：2026-08-23）

## 3. 协议规范约束

MCP 2026-07-28 是最适合做第一入口的共同标准：它基于 JSON-RPC 2.0，标准 transport 包括 stdio 和 Streamable HTTP；server 可暴露 tools/resources/prompts，client/host 负责 consent、tool safety 和 data privacy。工具名建议 1-128 字符，ASCII 字母数字、下划线、连字符、点；clients 应处理 tool list、tool call、pagination/caching、human-in-the-loop 等。[MCP specification](https://modelcontextprotocol.io/specification/2026-07-28)、[MCP transports](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports)、[MCP tools](https://modelcontextprotocol.io/specification/2026-07-28/server/tools)（访问：2026-08-23）

ACP 是 IDE/agent 间更重的 session-driving 协议；Kimi Code 已官方支持 `kimi acp`，但 Codex、Claude Code、Pi 的共同交集不是 ACP，因此不建议把 Partyline v1 建成 ACP-only。[Agent Client Protocol overview](https://agentclientprotocol.com/protocol/v1/overview)、[Kimi ACP](https://www.kimi.com/code/docs/en/kimi-code-cli/reference/kimi-acp)（访问：2026-08-23）

Agent Plugins v1 可作为 npm 包未来的可移植插件包装参考：固定 `plugin.json`，skills 在 `skills/`，MCP config 在 `mcp.json`，客户端必须做 plugin-root containment；但当前 Codex/Claude/Kimi/Pi 对同一个 plugin spec 的支持不均，不应成为 v1 必需项。[Agent Plugins specification](https://agent-plugins.org/specification)（访问：2026-08-23）

## 4. npm 包的最小跨 agent 通信协议建议

### 包形态

推荐包名先按工作名 `partyline`/`agent-partyline` 设计，暴露三个入口：

1. `partyline serve`：本地 foreground broker。默认只绑定 Unix-domain socket；需要 HTTP 时只绑定 `127.0.0.1`，且默认不开浏览器 UI。
2. `partyline mcp`：MCP stdio server，给 Codex / Claude Code / Kimi Code 接入。
3. `partyline rpc` 或普通 CLI：JSONL/CLI fallback，给 Pi、shell harness 和不支持 MCP 的环境接入。

暂不做：远程 SSH federation、Web dashboard mutations、provider 私有 socket 仿冒、自动审批、agent 启动/编排、工作树隔离、二进制插件市场。

### 最小工具面

MCP tools 和 JSONL method 保持同名：

- `partyline_register`：注册本 session 的 alias、agent kind、可选 session handle；返回 route id。
- `partyline_list`：列出本 broker 可见 routes 和 pair 状态，只给 sanitized metadata。
- `partyline_pair` / `partyline_unpair`：显式创建/移除两个 route 间 consent edge。
- `partyline_send`：发送一条 bounded text message；返回 `conversation_id`、`message_id`、`delivery_state`。
- `partyline_reply`：基于已有 `conversation_id` 回复；仍重新检查 caller、membership、pair。
- `partyline_await`：长轮询/等待本 alias 的 inbox；用于 Pi/shell 或没有 native inbound 的 agent。
- `partyline_status`：按 `message_id` 查询终态。

### 最小消息 envelope

```json
{
  "v": 1,
  "message_id": "msg_...",
  "conversation_id": "conv_...",
  "from": "codex-reviewer@this-mac",
  "to": "claude-advisor@this-mac",
  "kind": "message",
  "created_at": "2026-08-23T00:00:00.000Z",
  "ttl_ms": 14400000,
  "expects_reply": true,
  "body": { "type": "text", "text": "..." },
  "reply_to": null
}
```

Rules:

- `body.type = "text"` only in v1; attachments/files/commands wait.
- Body cap: 16 KiB default, configurable later only if real use demands it.
- Delivery states: `accepted`、`queued`、`delivered`、`unconfirmed`、`ambiguous`、`expired`、`failed`、`cancelled`。
- `delivered` means accepted by the receiving adapter/inbox boundary, not read or acted on by a model.
- `ambiguous` and `unconfirmed` are terminal; never auto-replay.
- Conversation token is a locator, not authority; every reply revalidates pair and caller.
- Tokens and bodies go through stdin/request body, never argv; logs and status views must not include raw bodies by default.

### Adapter policy

Codex：first-class MCP client integration is enough for v1. Avoid depending on Codex App Server unless building a separately labeled experimental adapter, because OpenAI marks the MCP server interface experimental and App Server has version-specific schemas. Use official MCP/client config first; if App Server is later used, require generated schema/version probing at runtime.

Claude Code：first-class MCP client integration is enough for v1. Do not imitate Claude peer registry/protocol unless explicitly shipping an experimental Claude-native adapter, because official cross-session messaging is for Claude sessions, and third-party peer advertisement is not documented as a stable API. A Claude user can call Partyline tools from the session through MCP.

Kimi Code：support MCP first; optionally support `kimi web` REST/WebSocket as a later adapter for richer session creation/event subscription. ACP is useful for IDEs but too broad for a communication broker v1.

Pi：support JSONL/CLI fallback first, because Pi core intentionally does not include built-in MCP. A Pi extension can wrap the same JSONL methods later; no need to make Pi drive an MCP client in v1.

### Security minimum

- Local-only by default: UDS or `127.0.0.1`; no public bind.
- Same-user assumption must be explicit. This is containment, not strong authentication.
- State directory mode 0700; state files mode 0600.
- Every cross-agent edge must be explicit and two-ended.
- No approval forwarding. If a message requests file writes/shell/network, the receiving agent’s native permission model must decide.
- No provider credentials in Partyline. It should never read Claude/Kimi/Codex tokens.
- Normalize errors into safe codes; raw paths, socket names, PIDs, thread IDs and stack traces stay diagnostic-only and off the normal message/status surface.

### Why this is smaller than Embassy

Embassy proves the product idea but spends most of its complexity on provider-native reachability: Claude registry/peer protocol, Codex App Server attach, dashboard mutation safety, delivery ambiguity, remote attach plans. Partyline can get useful cross-agent messaging sooner by using official MCP where available and a tiny JSONL fallback where not. Add native adapters only after a concrete need beats the simpler tool-call mailbox.

## 未验证项

- 未验证各工具在本机当前安装版本的实际 behavior；本文件只记录截至 2026-08-23 可访问的官方文档、官方仓库和源码事实。
- 未验证 Embassy 在本机实际启动、投递或 dashboard 行为；只验证其官方仓库文档、package 元数据和源码。
- 未找到 OpenAI 对 Embassy README 中 `CODEX_APP_SERVER_USE_LOCAL_DAEMON` 的官方文档；按 Embassy 自述，该变量是 observed/undocumented，Partyline 不应依赖它作为稳定入口。
