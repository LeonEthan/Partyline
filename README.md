# Partyline

本地 coding agent mailbox：让 Codex CLI/Desktop、Claude Code、Kimi Code、Pi 或普通 shell 进程通过同一个 Unix socket 交换有界文本消息。

Partyline v0.1 只做三件事：本地 broker、显式 pair、消息/回执状态。它不注入模型上下文、不绕过 agent 权限、不转发 provider token，也不把 `delivered` 伪装成“模型已经读过”。

## 运行

```bash
npm install
npm test
npm link

# 终端 1
partyline serve

# 注册两个 route，并显式授权通信
partyline register --name codex-main --kind codex
partyline register --name kimi-main --kind kimi
partyline pair --from codex-main --to kimi-main

# 人工发一条消息
partyline send --from codex-main --to kimi-main --message '请检查最近的 diff'
partyline await --name kimi-main
```

默认 socket 是 `$XDG_STATE_HOME/partyline/partyline.sock`，没有 `XDG_STATE_HOME` 时是 `~/.local/state/partyline/partyline.sock`。可用 `PARTYLINE_SOCKET` 或 `--socket` 覆盖。

## Agent 接入

Partyline 提供零依赖的 MCP stdio server。把下面的命令作为 MCP server 配到各 agent，并为每个 session 使用不同 alias：

```json
{
  "mcpServers": {
    "partyline": {
      "command": "partyline",
      "args": ["mcp", "--name", "codex-main", "--kind", "codex"]
    }
  }
}
```

Claude Code、Codex 和 Kimi Code 都有官方 MCP 接入面；因此这三个 agent 走同一个 `partyline mcp`。Codex Desktop 是否暴露相同配置入口取决于当前版本；Partyline v0.1 不依赖 Codex 私有 Desktop socket。

Pi 没有把 MCP 作为内置核心入口，使用 JSONL fallback：

```bash
partyline rpc --name pi-main --kind pi
```

stdin/stdout 每行一个请求/响应，例如：

```json
{"id":"1","method":"list","params":{}}
{"id":"2","method":"await","params":{"alias":"pi-main","timeout_ms":30000}}
```

Pi extension 或其他 harness 可以用 `child_process.spawn("partyline", ["rpc", ...])` 接入；不要把消息正文放在 argv 中。

## MCP tools

`partyline_register`、`partyline_list`、`partyline_pair`、`partyline_unpair`、`partyline_send`、`partyline_await`、`partyline_status` 对应同名的 broker 方法（去掉 `partyline_` 前缀）。`send` 需要发送方和接收方都已注册，并且已经显式 pair。

消息正文限制为 16 KiB，单个 mailbox 最多排队 100 条，TTL 默认 4 小时。`queued` 表示进入目标 mailbox，`delivered` 表示被 `await` 消费；两者都不表示目标模型已经阅读或执行。broker 重启会丢失内存中的 route、pair 和消息。

## 设计边界

Embassy 证明了本地 broker + 显式 pairing 的产品方向，但其 Claude peer protocol 和 Codex App Server 接入属于 provider-specific 边界。Partyline v0.1 先依赖官方 MCP/JSONL 入口，不复制这些私有协议；完整调研见 [`docs/research.md`](docs/research.md)。

当前刻意不做远程 federation、dashboard、自动审批、provider-native session 注入、agent 编排和文件/附件传输。真实使用中如果 MCP/JSONL mailbox 已经不够，再单独增加经过版本探测的 provider adapter。
