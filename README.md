# koishi-plugin-cf-tunnel

无需公网 IP、域名或 Cloudflare 账号，通过机器人指令为 Koishi WebUI 开启 Cloudflare Quick Tunnel，并在发送指令的平台直接收到临时 HTTPS 远程访问地址。插件不需要专用 WebUI。

## 使用

安装并启用本插件和 `server` 服务后，使用权限等级 **4** 或以上的账号向机器人发送：

```text
cf-tunnel.open
```

机器人先回复正在准备，公网就绪检查通过后在**同一会话**返回临时地址、有效期和空闲回收时间。私聊和群聊都可以使用。启用 `console` 插件时返回控制台路径，否则返回 HTTP 服务根地址。已有控制台的登录鉴权继续生效。

```text
cf-tunnel.open 60     开启有效 60 分钟的入口
cf-tunnel.status      查看地址、有效期、空闲剩余时间和流量
cf-tunnel.close       关闭入口，也可取消正在下载或连接的操作
```

默认有效 **30 分钟**，连续 **10 分钟没有公网流量**也会自动关闭；任一条件先达到即关闭。从公网就绪开始计时，首次下载和连接所用时间不占有效期。再次执行 open 会复用正在启动或已开启的入口，不会续期；需要新域名时先关闭再开启。

客户端固定保存在 `<Koishi 工作目录>/data/cf-tunnel/` 中：Windows 使用 `cloudflared.exe`，其他系统使用 `cloudflared`。每次开启只在此目录检查客户端，校验通过后直接复用；缺失或不可用时从 GitHub 官方发行页下载固定版本 `2026.10.0` 并校验大小和 SHA-256。支持 Windows x64、Linux x64/ARM64、macOS x64/ARM64。旧版保存在该目录下版本子目录中的缓存会自动迁移，无需重新下载。

## 配置

```yaml
plugins:
  cf-tunnel:
    targetUrl: 'http://127.0.0.1:5140'
    ttlMinutes: 30
    idleTimeoutMinutes: 10
    autoDownload: true
    startupTimeout: 90
    protocol: auto
```

| 配置 | 默认值 | 说明 |
| --- | --- | --- |
| `targetUrl` | `http://127.0.0.1:5140` | Koishi Web 地址，支持 HTTP/HTTPS；可含 `/console` 等入口路径；留空自动读取 server |
| `ttlMinutes` | `30` | 有效分钟数，1–1440；open 的可选参数可覆盖本次有效期 |
| `idleTimeoutMinutes` | `10` | 连续无公网流量的回收分钟数，0–1440；0 关闭空闲回收 |
| `autoDownload` | `true` | `data/cf-tunnel` 中没有可用客户端时自动下载并校验 |
| `startupTimeout` | `90` | 连接和公网就绪检查的总超时秒数，不含首次下载 |
| `protocol` | `auto` | 可选 `auto`、`quic`、`http2`；自动模式会根据网络选择传输协议 |

插件只会通过指令开启入口。停用插件、入口过期或客户端退出时会清理隧道和内部转发连接。

配置页的 `targetUrl` 是 cloudflared 转发的本地 Koishi Web 地址，填写 `127.0.0.1:5140` 也会自动补上 `http://`。填写路径时会用于生成回复的入口链接，HTTP/WebSocket 仍转发同一服务的整个端口，不会把其他路由拼到该路径后。HTTPS 使用正常证书校验。

开启前会检查目标是否能响应，连接失败时会提示修改 `targetUrl`。Koishi 日志中可以按 `cf-tunnel` 筛选：首次下载会立即显示 0%，每 5 秒显示百分比、已下载大小和平均速度，并记录校验完成及保存路径；固定目录内已有可用客户端时明确提示无需下载。cloudflared 的连接输出也会按其日志级别写入 Koishi 日志。`cf-tunnel.status` 在准备阶段可查看最新下载进度。

超时会区分尚未取得临时域名、已取得域名但连接未注册，以及公网检查未通过。连接超时不代表下载失败，具体原因需结合客户端日志判断。下载、目标检查和连接前的客户端准备不占 `startupTimeout`。

## 空闲回收如何计时

流量经过 `Cloudflare → cloudflared → 本机回环转发 → Koishi`。回环转发仅在隧道运行时监听随机端口，停止时释放；本地直接访问 Koishi 不会刷新空闲时间。

- HTTP 请求、请求体和响应体数据都会刷新计时。
- WebSocket 握手及双向数据都会刷新计时，**心跳也算流量**。因此打开控制台且持续产生心跳时不会因空闲而关闭，但仍受总有效期限制。
- 仅保持 TCP/WebSocket 连接而没有数据不会刷新计时。
- 插件自己的公网就绪探针不会刷新计时或计入流量；Cloudflare 传输层保活也不会计入。
- 空闲条件每秒检查一次。状态中的字节数统计 HTTP 消息体和 WebSocket 转发数据，不是网络账单流量。

## 访问范围

Quick Tunnel 转发**整个 Koishi HTTP 端口**，包括其他插件路由。访问权限由各路由本身的鉴权决定；使用控制台时应启用其 `auth` 登录。临时地址会直接发送到执行指令的会话，群聊中执行时群成员也能看到链接。

`console.selfUrl` 应保持为空，让页面和 WebSocket 使用同一临时域名。插件不修改 `server.selfUrl`，也不替其他 webhook 插件更新回调地址。Docker 部署时，`targetUrl` 应填写插件所在容器能够连接的 Koishi 地址。

临时域名每次重新开启会变化；入口关闭后远程连接会断开，本机 Koishi 和机器人继续运行。Quick Tunnel 适合临时访问，存在 Cloudflare 自身的服务限制，不支持 SSE。外部网络需要能够连接 Cloudflare；自动下载还需要连接 GitHub。

缓存位于 `<Koishi 工作目录>/data/cf-tunnel/`，停用或卸载不会删除已下载的客户端。

## 本地开发

需要 Node.js 20.3+。安装依赖后运行 `npm run build` 生成 `lib/`，再运行 `npm pack` 生成可安装的 `.tgz`。本包只有服务端代码，没有控制台页面或前端构建。

客户端固定发行元数据和生命周期设计参考 [magpie-intelligence-check](https://github.com/mu-zi-lee/magpie-intelligence-check)，版权声明见 `NOTICE`。本包不内置 cloudflared 二进制。

- [Cloudflare Quick Tunnels](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/)
- [Koishi 指令](https://koishi.chat/zh-CN/manual/usage/command.html)
