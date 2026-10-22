"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.Tunnel = void 0;
const node_child_process_1 = require("node:child_process");
const node_crypto_1 = require("node:crypto");
const fs = __importStar(require("node:fs/promises"));
const path = __importStar(require("node:path"));
const node_readline_1 = require("node:readline");
const runtime_1 = require("./runtime");
const proxy_1 = require("./proxy");
const errorText = (error) => error instanceof Error ? error.message : String(error);
class Tunnel {
    ctx;
    config;
    run;
    pending;
    stopping;
    disposed = false;
    state;
    logger;
    probeId = (0, node_crypto_1.randomBytes)(18).toString('hex');
    probePath = `/_cf-tunnel/health/${(0, node_crypto_1.randomBytes)(18).toString('hex')}`;
    cache;
    onExit = () => { this.run?.child?.kill(); };
    constructor(ctx, config) {
        this.ctx = ctx;
        this.config = config;
        this.logger = ctx.logger('cf-tunnel');
        this.cache = path.resolve(ctx.baseDir, 'data', 'cf-tunnel');
        this.state = {
            phase: 'stopped', message: '临时入口尚未开启', target: '',
            defaultMinutes: config.ttlMinutes, idleTimeoutMinutes: config.idleTimeoutMinutes,
            requests: 0, bytesIn: 0, bytesOut: 0, logs: [],
        };
        process.once('exit', this.onExit);
    }
    connection() {
        let input = this.config.targetUrl.trim();
        if (!input) {
            let { host, port } = this.ctx.server;
            if (!port || !this.ctx.server._http?.listening)
                throw new Error('Koishi HTTP 服务尚未开始监听，请稍后重试');
            if (!host || host === '0.0.0.0')
                host = '127.0.0.1';
            if (host === '::' || host === '[::]')
                host = '::1';
            if (host.includes(':') && !host.startsWith('['))
                host = `[${host}]`;
            input = `http://${host}:${port}`;
        }
        let address;
        try {
            address = new URL(input.includes('://') ? input : `http://${input}`);
        }
        catch {
            throw new Error('Koishi Web 地址无效，请填写如 http://127.0.0.1:5140');
        }
        if (!['http:', 'https:'].includes(address.protocol) || address.username || address.password || address.search || address.hash) {
            throw new Error('Koishi Web 地址仅支持 HTTP/HTTPS，不能包含账号、密码、查询参数或锚点');
        }
        const consoleConfig = this.ctx.get('console')?.config;
        const uiPath = address.pathname !== '/' ? address.pathname : consoleConfig?.uiPath ?? '/';
        return { target: address.origin, uiPath, selfUrl: consoleConfig?.selfUrl };
    }
    snapshot() {
        let target = this.state.target;
        try {
            target = this.connection().target;
        }
        catch { }
        const proxy = this.run?.proxy;
        const lastActivityAt = this.state.phase === 'running' ? proxy?.lastActivityAt : undefined;
        return {
            ...this.state, target, logs: [...this.state.logs], lastActivityAt,
            requests: proxy?.requests ?? this.state.requests,
            bytesIn: proxy?.bytesIn ?? this.state.bytesIn,
            bytesOut: proxy?.bytesOut ?? this.state.bytesOut,
            idleExpiresAt: lastActivityAt && this.config.idleTimeoutMinutes ? lastActivityAt + this.config.idleTimeoutMinutes * 60_000 : undefined,
        };
    }
    update(patch) {
        this.state = { ...this.state, ...patch };
    }
    log(text, level = 'info') {
        const line = text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').slice(0, 800);
        this.state.logs = [...this.state.logs, { time: Date.now(), text: line }].slice(-60);
        this.logger[level]('%s', line);
    }
    start(minutes = this.config.ttlMinutes) {
        if (this.disposed)
            throw new Error('插件已停用');
        if (!Number.isInteger(minutes) || minutes < 1 || minutes > 1440)
            throw new Error('有效时间必须为 1–1440 分钟的整数');
        if (this.stopping)
            throw new Error('正在关闭旧入口，请稍后再开启');
        if (this.pending)
            return this.pending;
        if (this.run && this.state.phase === 'running')
            return Promise.resolve(this.snapshot());
        const run = { abort: new AbortController() };
        this.run = run;
        this.update({ phase: 'preparing', message: '正在准备 cloudflared', url: undefined, consoleUrl: undefined, startedAt: undefined, expiresAt: undefined, requests: 0, bytesIn: 0, bytesOut: 0, logs: [] });
        const pending = this.open(run, minutes).catch(async (error) => {
            await this.terminate(run);
            if (this.run === run) {
                this.run = undefined;
                const message = errorText(error);
                this.log(message, 'warn');
                this.update({ phase: 'error', message, url: undefined, consoleUrl: undefined, expiresAt: undefined });
            }
            throw error;
        }).finally(() => {
            if (this.pending === pending)
                this.pending = undefined;
        });
        this.pending = pending;
        return pending;
    }
    async open(run, minutes) {
        const signal = run.abort.signal;
        const connection = this.connection();
        if (connection.selfUrl)
            throw new Error('console 插件设置了固定 selfUrl，请清空该配置后使用临时域名（前后端需同源）');
        this.update({ target: connection.target });
        await this.checkTarget(connection.target, connection.uiPath, signal);
        const binary = await (0, runtime_1.resolveBinary)(this.config, this.cache, signal, text => {
            this.log(text);
            this.update({ message: text });
        });
        signal.throwIfAborted();
        await fs.mkdir(this.cache, { recursive: true, mode: 0o700 });
        const temporary = await fs.mkdtemp(path.join(this.cache, 'tunnel-'));
        try {
            const configFile = path.join(temporary, 'config.yaml');
            await fs.writeFile(configFile, '{}\n', { mode: 0o600 });
            signal.throwIfAborted();
            run.proxy = new proxy_1.TrafficProxy(connection.target, this.probePath, this.probeId, error => this.logger.warn('隧道本机转发错误：%s', errorText(error)));
            const proxyUrl = await run.proxy.listen(signal);
            signal.throwIfAborted();
            this.update({ phase: 'starting', message: '正在连接 Cloudflare' });
            this.log(`连接 Koishi Web ${connection.target}，传输协议 ${this.config.protocol}，Cloudflare 启动超时 ${this.config.startupTimeout} 秒`);
            const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(TUNNEL_|CLOUDFLARED_)/i.test(key)));
            const child = (0, node_child_process_1.spawn)(binary, [
                'tunnel', '--config', configFile, '--no-autoupdate', '--url', proxyUrl,
                '--protocol', this.config.protocol, '--edge-ip-version', '4', '--metrics', '127.0.0.1:0',
            ], { env, cwd: temporary, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
            run.child = child;
            run.closed = new Promise(resolve => child.once('close', () => resolve()));
            const deadline = Date.now() + this.config.startupTimeout * 1000;
            const origin = await this.registration(run, child, deadline);
            signal.throwIfAborted();
            this.update({ phase: 'checking', message: '隧道已连接，正在检查公网访问' });
            this.log('Cloudflare 连接已注册，正在检查公网访问');
            await this.checkReady(origin, signal, deadline);
            signal.throwIfAborted();
            if (child.exitCode !== null || child.signalCode !== null)
                throw new Error('cloudflared 已退出，请重新开启入口');
            const now = Date.now();
            run.proxy.lastActivityAt = now;
            const consoleUrl = new URL(connection.uiPath.replace(/^\/*/, '/'), origin).href;
            run.cancelExpiry = this.ctx.setTimeout(() => {
                void this.stop('有效时间已到，临时入口已自动关闭').catch(error => this.logger.warn(error));
            }, minutes * 60_000);
            if (this.config.idleTimeoutMinutes > 0) {
                run.cancelIdle = this.ctx.setInterval(() => {
                    if (this.run !== run || !run.proxy)
                        return;
                    if (Date.now() - run.proxy.lastActivityAt < this.config.idleTimeoutMinutes * 60_000)
                        return;
                    void this.stop(`连续 ${this.config.idleTimeoutMinutes} 分钟没有公网流量，临时入口已自动关闭`).catch(error => this.logger.warn(error));
                }, 1000);
            }
            this.log(`公网检查通过，入口将在 ${minutes} 分钟后关闭`);
            this.update({ phase: 'running', message: '临时入口已就绪', url: origin, consoleUrl, startedAt: now, expiresAt: now + minutes * 60_000 });
            this.logger.info('临时公网入口已就绪，有效 %s 分钟，空闲回收 %s 分钟', minutes, this.config.idleTimeoutMinutes || '关闭');
            return this.snapshot();
        }
        finally {
            // Keep the empty config until cloudflared exits, including after startup.
            if (run.child && run.closed) {
                void run.closed.then(() => fs.rm(temporary, { recursive: true, force: true })).catch(error => this.logger.debug(error));
            }
            else {
                await fs.rm(temporary, { recursive: true, force: true });
            }
        }
    }
    registration(run, child, deadline) {
        return new Promise((resolve, reject) => {
            let origin = '';
            let registered = false;
            let lastError = '';
            let settled = false;
            const signal = run.abort.signal;
            const finish = (error) => {
                if (settled)
                    return;
                settled = true;
                clearTimeout(timer);
                signal.removeEventListener('abort', aborted);
                if (error)
                    reject(error);
                else
                    resolve(origin);
            };
            const aborted = () => finish(new Error('已取消开启临时入口'));
            const timer = setTimeout(() => {
                const stage = !origin
                    ? registered ? '连接已注册，但未识别到临时域名' : '尚未取得临时域名'
                    : '已取得临时域名，但尚未完成连接注册';
                const detail = lastError ? `；最近客户端错误：${lastError}` : '；请查看 cf-tunnel 日志中的客户端连接详情';
                finish(new Error(`Cloudflare 连接超时（${this.config.startupTimeout} 秒，${stage}）${detail}`));
            }, Math.max(1, deadline - Date.now()));
            signal.addEventListener('abort', aborted, { once: true });
            if (signal.aborted)
                aborted();
            for (const stream of [child.stdout, child.stderr]) {
                if (!stream)
                    continue;
                const reader = (0, node_readline_1.createInterface)({ input: stream });
                reader.on('line', line => {
                    const level = line.match(/^\S+\s+(DBG|INF|WRN|ERR|FTL|PNC)\b/)?.[1];
                    this.log(line, level === 'DBG' ? 'debug' : level === 'WRN' ? 'warn' : ['ERR', 'FTL', 'PNC'].includes(level || '') ? 'error' : 'info');
                    if (['ERR', 'FTL', 'PNC'].includes(level || ''))
                        lastError = line.replace(/^\S+\s+\S+\s*/, '').slice(0, 240);
                    const match = line.match(/https:\/\/[a-z0-9]+(?:-[a-z0-9]+)*\.trycloudflare\.com(?=\s|$)/);
                    if (match && !origin) {
                        origin = match[0];
                        if (this.run === run && !signal.aborted) {
                            this.update({ message: '已取得临时域名，正在等待 Cloudflare 连接注册' });
                            this.log('已取得临时域名，正在等待 Cloudflare 连接注册');
                        }
                    }
                    if (line.includes('Registered tunnel connection'))
                        registered = true;
                    if (origin && registered)
                        finish();
                });
                child.once('close', () => reader.close());
            }
            child.once('error', error => finish(new Error(`无法启动 cloudflared：${error.message}`)));
            child.once('close', (code, reason) => {
                finish(new Error(`cloudflared 已退出（${reason || (code ?? '未知原因')}）`));
                if (this.run !== run || signal.aborted)
                    return;
                this.run = undefined;
                run.cancelExpiry?.();
                run.cancelIdle?.();
                run.abort.abort();
                void run.proxy?.close().catch(error => this.logger.debug(error));
                const message = `cloudflared 意外退出（${reason || (code ?? '未知原因')}），入口已失效`;
                this.log(message, 'warn');
                this.update({ phase: 'error', message, url: undefined, consoleUrl: undefined, expiresAt: undefined });
            });
        });
    }
    async checkTarget(target, uiPath, signal) {
        const address = new URL(uiPath, target).href;
        this.update({ message: '正在检查 Koishi Web 地址' });
        this.log(`正在检查 Koishi Web 地址：${address}`);
        try {
            const response = await fetch(address, {
                redirect: 'manual', signal: AbortSignal.any([signal, AbortSignal.timeout(7000)]),
            });
            await response.body?.cancel();
            this.log(`Koishi Web 已响应（HTTP ${response.status}）`);
        }
        catch (error) {
            signal.throwIfAborted();
            const cause = error instanceof Error && error.cause instanceof Error ? `，${error.cause.message}` : '';
            throw new Error(`无法连接 Koishi Web ${address}：${errorText(error)}${cause}；请检查 targetUrl 配置`, { cause: error });
        }
    }
    async checkReady(origin, signal, deadline) {
        let last = '网络未就绪';
        while (Date.now() < deadline) {
            signal.throwIfAborted();
            try {
                const response = await fetch(new URL(this.probePath, origin), {
                    redirect: 'error', cache: 'no-store',
                    signal: AbortSignal.any([signal, AbortSignal.timeout(Math.max(1, Math.min(5000, deadline - Date.now())))]),
                });
                const valid = response.status === 204 && response.headers.get('x-koishi-cf-tunnel') === this.probeId;
                last = `HTTP ${response.status}`;
                await response.body?.cancel();
                if (valid)
                    return;
            }
            catch (error) {
                signal.throwIfAborted();
                last = errorText(error);
            }
            await new Promise(resolve => {
                const done = () => { clearTimeout(timer); signal.removeEventListener('abort', done); resolve(); };
                const timer = setTimeout(done, Math.min(1000, Math.max(1, deadline - Date.now())));
                signal.addEventListener('abort', done, { once: true });
                if (signal.aborted)
                    done();
            });
        }
        throw new Error(`公网访问检查未通过（${last}），已关闭本次隧道`);
    }
    async terminate(run) {
        run.cancelExpiry?.();
        run.cancelIdle?.();
        run.abort.abort();
        await run.proxy?.close();
        const child = run.child;
        if (!child || !run.closed || child.exitCode !== null || child.signalCode !== null)
            return;
        child.kill('SIGTERM');
        const timer = setTimeout(() => child.kill('SIGKILL'), 3000);
        try {
            await run.closed;
        }
        finally {
            clearTimeout(timer);
        }
    }
    stop(message = '临时入口已关闭') {
        if (this.stopping)
            return this.stopping;
        const run = this.run;
        const pending = this.pending;
        this.run = undefined;
        this.update({ phase: 'stopping', message: '正在关闭临时入口', url: undefined, consoleUrl: undefined, expiresAt: undefined });
        const stopping = (async () => {
            if (run)
                await this.terminate(run);
            await pending?.catch(() => { });
            this.log(message);
            this.update({ phase: 'stopped', message, startedAt: undefined });
            return this.snapshot();
        })().finally(() => { if (this.stopping === stopping)
            this.stopping = undefined; });
        this.stopping = stopping;
        return stopping;
    }
    async dispose() {
        this.disposed = true;
        process.removeListener('exit', this.onExit);
        await this.stop('插件已停用，临时入口已关闭');
    }
}
exports.Tunnel = Tunnel;
