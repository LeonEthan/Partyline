# Partyline 的 Unix Domain Socket（UDS）调研

访问日期：2026-08-23。结论只使用官方文档、系统手册和当前 Partyline 源码；未修改实现。

## 结论

对于 Partyline 的本地 broker，UDS 比 loopback TCP 更合适，应继续作为 Unix 平台的默认控制面传输。

但 UDS 只是传输层，不能替代 MCP、Pi RPC、ACP、Claude peer protocol 或 Codex App Server 等上层协议。推荐的分层是：

```text
Codex / Claude / Kimi MCP host  --stdio-->  partyline mcp  --UDS-->  Partyline broker
Pi / shell RPC                 --JSONL-->  partyline rpc  --UDS-->  Partyline broker
```

不要让每两个 agent 之间都建立一条 UDS；保留一个 broker socket，所有 route 通过 broker 做 pair、权限、排队和状态管理。

## 一手资料结论

### UDS 的适用性

Linux `unix(7)` 将 AF_UNIX 定义为同机进程间通信，并支持 pathname socket、Linux abstract socket、凭据传递和文件描述符传递。[Linux `unix(7)`](https://man7.org/linux/man-pages/man7/unix.7.html)

Node 的 `node:net` 把 TCP 和 IPC 都抽象成 stream server/client；Unix 使用 UDS，Windows 使用 named pipe。Node 的 `listen(path)`、`createConnection(path)` 可以复用当前 JSONL 控制协议。[Node.js `net` IPC](https://nodejs.org/api/net.html)

### 权限和认证

Linux pathname socket 会受到所在目录权限影响，连接 stream socket 还需要对 socket 文件有写权限；但 POSIX 不保证各系统都以相同方式解释 socket 文件权限，因此不能把 `chmod 0600` 当成跨 Unix 的完整认证机制。[Linux `unix(7)` 的 ownership and permissions](https://man7.org/linux/man-pages/man7/unix.7.html)

Linux 可以使用 `SO_PEERCRED`，macOS/BSD 可以使用 `getpeereid()` 获取对端有效 UID/GID。Apple 文档明确说明该凭据由内核提供，连接双方不能在用户态伪造。[Apple `getpeereid(3)`](https://developer.apple.com/library/archive/documentation/System/Conceptual/ManPages_iPhoneOS/man3/getpeereid.3.html)

所以 UDS 的正确安全假设是“限制其他 OS 用户 + 校验 peer credential”，不是“连上 socket 就可信”。同一 UID 下的恶意进程仍不应被视为天然可信。

### 生命周期和路径

Node 文档指出，Unix pathname socket 的路径通常限制为 Linux 107 bytes、macOS 103 bytes；pathname socket 在进程崩溃后可能留下文件，需要启动时安全探测和清理。Linux abstract socket 会自动消失，但它是 Linux-only、不可通过文件权限保护、也不利于诊断。[Node.js `net` path behavior](https://nodejs.org/api/net.html)、[Linux `unix(7)` abstract sockets](https://man7.org/linux/man-pages/man7/unix.7.html)

当前 Partyline 默认路径 `~/.local/state/partyline/partyline.sock` 足够短，但应继续做 byte-length 校验；清理 stale socket 时应使用 `lstat`、确认目标确实是 socket，并处理 `EADDRINUSE`，不能对任意同名文件执行 unlink。

### MCP 不应改成 UDS-only

MCP 标准 transport 是 stdio 和 Streamable HTTP；stdio 的约定就是 host 启动 server 子进程，server 通过 stdin/stdout 交换 JSON-RPC。MCP 允许 custom transport，但客户端是否支持 UDS endpoint 不能假定。[MCP transports](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports)

因此 `partyline mcp` 继续使用 stdio，内部再连接 broker UDS，兼容性最好。直接把 broker 暴露成 UDS MCP endpoint 会牺牲 Codex、Claude、Kimi 的配置兼容性，收益很小。

### Embassy 的验证

Embassy 的架构文档采用 private same-user Unix-domain control socket，并明确 `serve` 不增加 TCP listener；它把 UDS 用作 thin client 到本地 broker 的控制面，而不是把 UDS 当作跨 provider 的 session protocol。[Embassy Gateway Architecture](https://github.com/YuanpingSong/embassy/blob/main/docs/GATEWAY-ARCHITECTURE.md)

## 方案比较

| 维度 | UDS pathname | TCP `127.0.0.1` | stdio |
| --- | --- | --- | --- |
| 适用范围 | 同机进程 | 同机，也可扩展到远端 | 父子进程 |
| Partyline broker | 最合适 | 可作为 fallback | 不适合多个独立 agent 共用 |
| 发现 | 固定 socket path | port/lock/discovery | 由 host 配置 |
| 本地暴露面 | 不监听 TCP；可用目录/文件权限收敛 | 需要端口、bind、token/auth | 由父进程边界控制 |
| 生命周期 | crash 后可能留下 socket 文件 | port 释放但可能遇到复用/竞态 | 随父子进程生命周期 |
| 跨平台 | Unix 原生；Node 在 Windows 映射为 named pipe | 广泛可用 | 广泛可用 |
| 远程/容器 | 需要挂载 socket 文件或额外代理 | 更自然，但要认证和网络边界 | 需要由远端进程托管 |
| 结论 | Partyline 默认 | 未来 remote/container adapter | MCP provider adapter |

## 对当前 Partyline 实现的具体判断

当前 `src/broker.mjs` 已经选择了正确的主方向：一个 broker-owned pathname socket、JSONL framing、600 socket mode、stale socket 探测和显式 route/pair 状态。对于本地 macOS/Linux MVP，不需要换成 TCP。

需要记住以下边界：

1. `hello { role: "operator" }` 是协议字段，不是认证。任何能连上 UDS 的同 UID 进程都可能自报 operator；后续应改成 peer credential 检查、broker 生成的 capability token，或二者组合。
2. 当前 `fs.stat/isSocket/chmod/unlink` 路径是 Unix-specific。若 npm 包声明支持 Windows，应把抽象命名为 `ipc endpoint`，在 Windows 使用 named pipe 分支，不对 pipe 调用 Unix 文件操作。
3. UDS stream 不保留 JSON message boundary；当前 newline framing、最大 frame 和 body 上限仍然需要，不能因为用了 UDS 就去掉协议层 framing。
4. UDS 只能解决 broker 的本地连接，不能自动唤醒另一个 agent，也不能把不同 provider 的 session wire protocol 变成同一个协议。
5. 容器跨 namespace、远程机器、跨用户通信不应硬塞进 UDS；应明确增加 loopback TCP、SSH 或 Streamable HTTP adapter，并重新设计认证和重连语义。

## 本机微基准

在当前 macOS arm64、Node v24.19.0 上，用同一份 10,000 次 JSONL stream echo 做了一个 transport-only 微基准：UDS 约 1.05–1.72M round-trips/s，TCP loopback 约 0.70–0.81M round-trips/s。这个结果只说明 UDS 的本地 transport overhead 较低，不能代表 agent 端到端延迟；模型推理、MCP host 调度和 provider adapter 才是实际主成本。

## 决策

- 保留 UDS 作为 Partyline broker 的 Unix 默认 transport。
- 保留 MCP stdio 和 Pi JSONL 作为 agent-facing adapter。
- 不新增 UDS-to-UDS 的 provider-native 仿冒层。
- 下一次安全改动优先补 peer identity/operator capability；跨平台改动优先抽象 Unix pathname socket 与 Windows named pipe。
- 只有出现跨容器、跨机器或不支持 UDS 的 host 需求时，才增加 TCP/HTTP/SSH adapter。
