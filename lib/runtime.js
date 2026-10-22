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
exports.VERSION = void 0;
exports.resolveBinary = resolveBinary;
const node_child_process_1 = require("node:child_process");
const node_crypto_1 = require("node:crypto");
const fs = __importStar(require("node:fs/promises"));
const path = __importStar(require("node:path"));
const node_util_1 = require("node:util");
const execute = (0, node_util_1.promisify)(node_child_process_1.execFile);
exports.VERSION = '2026.10.0';
// Pinned release metadata from magpie-intelligence-check; attribution in NOTICE.
const releases = {
    'linux-x64': ['linux-amd64', 'd33ff2d14475178d2012c2c56beba87389ac5ded27649519f198a7d3134a99db', 40129756],
    'linux-arm64': ['linux-arm64', 'e6422b9d4f72d3194bc5a38676f13667c06666523217b842a877d72a80b5ac08', 37687584],
    'darwin-x64': ['darwin-amd64.tgz', '903845b81828c8cb3c5d13d816a2de71c06a3da5785469df8eb0e1b736d92f9f', 21741581, '0560c9ab7281ac3f746055323623ed23bc0405b6dab9400474020cba33a978da'],
    'darwin-arm64': ['darwin-arm64.tgz', 'a2f79ff7b9420aa537d74af239f376da170bbabeb529aec416002adac6a72e70', 19809074, '72edfd3eea463aef4d5cb89e2e209cecb048cc756c2b01915de2e0ad7cb39830'],
    'win32-x64': ['windows-amd64.exe', '86aee4017b26625cee8484c113558f48effa4cd47f7aa05fcf425604e5d2b23c', 55365048],
};
const digest = (bytes) => (0, node_crypto_1.createHash)('sha256').update(bytes).digest('hex');
async function probe(binary, signal) {
    signal.throwIfAborted();
    try {
        const { stdout } = await execute(binary, ['--version'], {
            timeout: 5000, maxBuffer: 16384, windowsHide: true, signal,
        });
        const version = stdout.match(/cloudflared version (\d{4})\.\d+\.\d+/);
        return !!version && Number(version[1]) >= 2024;
    }
    catch {
        signal.throwIfAborted();
        return false;
    }
}
async function download(url, hash, size, signal, log) {
    const original = url;
    const timeout = AbortSignal.any([signal, AbortSignal.timeout(120_000)]);
    let total = 0;
    const started = Date.now();
    const progress = () => {
        const percent = Math.floor(total / size * 100);
        const speed = total / Math.max(1, (Date.now() - started) / 1000) / 1024 / 1024;
        log(`cloudflared 下载进度 ${percent}%（${(total / 1024 / 1024).toFixed(1)} / ${(size / 1024 / 1024).toFixed(1)} MiB，${speed.toFixed(2)} MiB/s）`);
    };
    progress();
    const timer = setInterval(progress, 5000);
    try {
        for (let hop = 0; hop < 5; hop++) {
            const parsed = new URL(url);
            if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port
                || (url !== original && parsed.hostname !== 'release-assets.githubusercontent.com')) {
                throw new Error('cloudflared 下载被重定向到非官方地址');
            }
            const response = await fetch(url, { redirect: 'manual', signal: timeout });
            if ([301, 302, 303, 307, 308].includes(response.status)) {
                const location = response.headers.get('location');
                await response.body?.cancel();
                if (!location)
                    throw new Error('cloudflared 下载重定向缺少地址');
                url = new URL(location, url).href;
                continue;
            }
            if (!response.ok || !response.body)
                throw new Error(`cloudflared 下载失败：HTTP ${response.status}`);
            const chunks = [];
            const reader = response.body.getReader();
            try {
                while (true) {
                    const { done, value } = await reader.read();
                    if (done)
                        break;
                    total += value.byteLength;
                    if (total > size)
                        throw new Error('cloudflared 下载文件超过预期大小');
                    chunks.push(Buffer.from(value));
                }
            }
            finally {
                await reader.cancel().catch(() => { });
            }
            progress();
            log('cloudflared 下载结束，正在校验文件大小和 SHA-256');
            const bytes = Buffer.concat(chunks);
            if (total !== size || digest(bytes) !== hash)
                throw new Error('cloudflared 文件校验失败，已拒绝执行');
            return bytes;
        }
        throw new Error('cloudflared 下载重定向过多');
    }
    catch (error) {
        if (signal.aborted)
            throw new Error('已取消下载 cloudflared');
        const message = error instanceof Error ? error.message : String(error);
        const cause = error instanceof Error && error.cause instanceof Error ? `（${error.cause.message}）` : '';
        throw new Error(`cloudflared 下载未完成：${message}${cause}`, { cause: error });
    }
    finally {
        clearInterval(timer);
    }
}
async function resolveBinary(config, cacheRoot, signal, log) {
    const target = `${process.platform}-${process.arch}`;
    const release = releases[target];
    if (!release)
        throw new Error(`暂不支持 ${target} 平台的 cloudflared 客户端`);
    const [asset, archiveHash, size, binaryHash = archiveHash] = release;
    const filename = process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared';
    const binary = path.join(cacheRoot, filename);
    const usable = async (candidate) => {
        try {
            const stat = await fs.lstat(candidate);
            if (!stat.isFile() || stat.size > 100 * 1024 * 1024)
                return false;
            return digest(await fs.readFile(candidate)) === binaryHash && await probe(candidate, signal);
        }
        catch {
            signal.throwIfAborted();
            return false;
        }
    };
    log(`正在检查固定位置的 cloudflared：${binary}`);
    if (await usable(binary)) {
        log(`使用已校验的 cloudflared ${exports.VERSION}：${binary}，无需重复下载`);
        return binary;
    }
    // Reuse downloads made by older plugin versions without searching outside our data directory.
    const legacy = path.join(cacheRoot, `cloudflared-${exports.VERSION}-${target}`, filename);
    if (await usable(legacy)) {
        signal.throwIfAborted();
        await fs.copyFile(legacy, binary);
        await fs.chmod(binary, 0o700);
        log(`已将旧版 cloudflared 缓存迁移到固定位置：${binary}，无需重复下载`);
        return binary;
    }
    if (!config.autoDownload)
        throw new Error(`固定目录内没有可用的 cloudflared：${binary}；请启用 autoDownload`);
    log(`首次使用，正在下载 cloudflared ${exports.VERSION}（${Math.ceil(size / 1024 / 1024)} MB）`);
    const bytes = await download(`https://github.com/cloudflare/cloudflared/releases/download/${exports.VERSION}/cloudflared-${asset}`, archiveHash, size, signal, log);
    signal.throwIfAborted();
    await fs.mkdir(cacheRoot, { recursive: true, mode: 0o700 });
    const stage = await fs.mkdtemp(path.join(cacheRoot, '.install-'));
    try {
        const staged = path.join(stage, filename);
        if (asset.endsWith('.tgz')) {
            const archive = path.join(stage, 'release.tgz');
            await fs.writeFile(archive, bytes, { mode: 0o600 });
            await execute('tar', ['-xzf', archive, '--no-same-owner', '--no-same-permissions', '-C', stage, 'cloudflared'], {
                timeout: 30_000, maxBuffer: 16384, windowsHide: true, signal,
            });
        }
        else {
            await fs.writeFile(staged, bytes, { mode: 0o700 });
        }
        if (digest(await fs.readFile(staged)) !== binaryHash)
            throw new Error('解压后的 cloudflared 校验失败');
        await fs.chmod(staged, 0o700);
        if (!await probe(staged, signal))
            throw new Error('下载的 cloudflared 无法运行');
        signal.throwIfAborted();
        await fs.copyFile(staged, binary);
        await fs.chmod(binary, 0o700);
        log(`cloudflared 下载和 SHA-256 校验完成，已保存到：${binary}`);
        return binary;
    }
    finally {
        await fs.rm(stage, { recursive: true, force: true });
    }
}
