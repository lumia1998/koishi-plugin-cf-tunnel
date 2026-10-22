"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.Config = exports.usage = exports.inject = exports.name = void 0;
exports.apply = apply;
const koishi_1 = require("koishi");
const tunnel_1 = require("./tunnel");
exports.name = 'cf-tunnel';
exports.inject = { required: ['server'], optional: ['console'] };
exports.usage = `
向机器人发送 **cf-tunnel.open**，就绪后机器人会在当前会话返回 Cloudflare 临时地址。

- 指令要求权限等级 4，支持私聊和群聊。
- 默认有效 30 分钟，连续 10 分钟没有公网流量也会自动关闭；两者先到者生效。
- HTTP 请求、请求/响应数据和 WebSocket 数据（含心跳）都会刷新空闲时间。
- 客户端固定保存在 Koishi 工作目录的 data/cf-tunnel 中，每次开启先检查并复用，缺失时下载；进度和连接详情显示在 Koishi 日志中。
- 隧道转发整个 Koishi HTTP 端口；访问控制台继续使用现有的登录鉴权。
- 如使用 console 插件，其 selfUrl 应保持为空，使前后端使用同一临时域名。

指令：\`cf-tunnel.open [分钟数]\`、\`cf-tunnel.close\`、\`cf-tunnel.status\`。
`;
exports.Config = koishi_1.Schema.intersect([
    koishi_1.Schema.object({
        targetUrl: koishi_1.Schema.string().default('http://127.0.0.1:5140').description('Koishi Web 地址，支持 HTTP/HTTPS，例如 http://127.0.0.1:5140。可附带 /console 等入口路径；留空则自动读取本实例 server 地址。'),
        ttlMinutes: koishi_1.Schema.number().min(1).max(1440).step(1).default(30).description('默认有效时间（分钟），从公网就绪开始计算。再次开启已运行的入口不会续期。'),
        idleTimeoutMinutes: koishi_1.Schema.number().min(0).max(1440).step(1).default(10).description('连续多久没有公网流量时自动关闭（分钟）。0 表示关闭空闲回收；HTTP 和 WebSocket 心跳也算流量。'),
    }).description('临时入口'),
    koishi_1.Schema.object({
        autoDownload: koishi_1.Schema.boolean().default(true).description('data/cf-tunnel 中没有可用客户端时，从 GitHub 官方发行页下载固定版本并校验 SHA-256，保存到该目录。'),
        startupTimeout: koishi_1.Schema.number().min(15).max(300).step(1).default(90).description('连接和公网就绪检查的总超时（秒），不含首次下载时间。'),
        protocol: koishi_1.Schema.union(['http2', 'quic', 'auto']).default('auto').description('隧道传输协议。默认自动选择；UDP 不可用时可改为 HTTP/2。'),
    }).description('Cloudflare 客户端'),
]);
function describe(state) {
    const lines = [state.message];
    if (state.phase !== 'running')
        return lines.join('\n');
    lines.push(state.consoleUrl || state.url);
    if (state.expiresAt)
        lines.push(`有效期剩余 ${Math.max(0, Math.ceil((state.expiresAt - Date.now()) / 60_000))} 分钟`);
    if (state.idleExpiresAt) {
        lines.push(`连续 ${state.idleTimeoutMinutes} 分钟无流量自动关闭（当前剩余 ${Math.max(0, Math.ceil((state.idleExpiresAt - Date.now()) / 1000))} 秒）`);
    }
    lines.push(`隧道请求 ${state.requests} 次，接收 ${state.bytesIn} 字节，发送 ${state.bytesOut} 字节`);
    return lines.join('\n');
}
function apply(ctx, config) {
    const tunnel = new tunnel_1.Tunnel(ctx, config);
    const command = ctx.command('cf-tunnel', '管理 Cloudflare 临时公网入口', { authority: 4 });
    command.subcommand('.open [minutes:number]', '开启临时公网入口，可指定有效分钟数', { authority: 4 }).action(async ({ session }, minutes) => {
        try {
            if (tunnel.snapshot().phase !== 'running')
                await session?.send('正在准备 Cloudflare 临时入口，首次使用可能需要下载客户端，请稍候。');
            return describe(await tunnel.start(minutes));
        }
        catch (error) {
            return `临时入口未能开启：${error instanceof Error ? error.message : String(error)}`;
        }
    });
    command.subcommand('.close', '关闭临时公网入口', { authority: 4 }).action(async () => {
        await tunnel.stop();
        return '临时公网入口已关闭。';
    });
    command.subcommand('.status', '查看临时地址、剩余时间和流量', { authority: 4 }).action(() => describe(tunnel.snapshot()));
    ctx.on('dispose', () => tunnel.dispose());
}
