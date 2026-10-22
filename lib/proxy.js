"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TrafficProxy = void 0;
const node_http_1 = require("node:http");
const node_https_1 = require("node:https");
const node_net_1 = require("node:net");
const node_tls_1 = require("node:tls");
function forwardHeaders(headers) {
    const result = { ...headers };
    const connection = [headers.connection ?? ''].flat().join(',');
    const excluded = ['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade', ...connection.split(',')];
    for (const name of excluded)
        delete result[name.trim().toLowerCase()];
    return result;
}
/** A private loopback hop, so local Koishi traffic never resets the tunnel's idle clock. */
class TrafficProxy {
    probePath;
    probeId;
    server;
    sockets = new Set();
    target;
    opening;
    closed;
    lastActivityAt = Date.now();
    requests = 0;
    bytesIn = 0;
    bytesOut = 0;
    constructor(target, probePath, probeId, onError) {
        this.probePath = probePath;
        this.probeId = probeId;
        this.target = new URL(target);
        const secure = this.target.protocol === 'https:';
        const hostname = this.target.hostname.replace(/^\[|\]$/g, '');
        const port = Number(this.target.port || (secure ? 443 : 80));
        this.server = (0, node_http_1.createServer)((incoming, outgoing) => {
            if (incoming.url === this.probePath) {
                outgoing.writeHead(204, { 'X-Koishi-CF-Tunnel': this.probeId, 'Cache-Control': 'no-store' });
                outgoing.end();
                return;
            }
            this.touch();
            this.requests++;
            const upstream = (secure ? node_https_1.request : node_http_1.request)({
                hostname, port,
                // The public Host header must not select the upstream TLS identity.
                servername: (0, node_net_1.isIP)(hostname) ? '' : hostname,
                method: incoming.method, path: incoming.url || '/',
                headers: forwardHeaders(incoming.headers), agent: false,
            }, response => {
                this.touch();
                outgoing.writeHead(response.statusCode || 502, forwardHeaders(response.headers));
                response.on('data', (data) => this.touch('out', data.length));
                response.on('error', () => outgoing.destroy());
                response.on('aborted', () => outgoing.destroy());
                response.pipe(outgoing);
            });
            upstream.on('socket', socket => this.track(socket));
            upstream.on('error', () => {
                if (outgoing.headersSent)
                    outgoing.destroy();
                else {
                    outgoing.writeHead(502);
                    outgoing.end('Koishi upstream unavailable');
                }
            });
            incoming.on('data', (data) => this.touch('in', data.length));
            incoming.on('aborted', () => upstream.destroy());
            incoming.on('error', () => upstream.destroy());
            outgoing.on('close', () => { if (!outgoing.writableFinished)
                upstream.destroy(); });
            incoming.pipe(upstream);
        });
        this.server.on('connection', socket => this.track(socket));
        this.server.on('upgrade', (incoming, socket, head) => {
            this.touch();
            this.requests++;
            const options = { host: hostname, port };
            const upstream = secure
                ? (0, node_tls_1.connect)({ ...options, servername: (0, node_net_1.isIP)(hostname) ? undefined : hostname })
                : (0, node_net_1.createConnection)(options);
            const connected = secure ? 'secureConnect' : 'connect';
            const connectTimeout = setTimeout(() => upstream.destroy(new Error('Koishi upstream connection timeout')), 10_000);
            upstream.once(connected, () => clearTimeout(connectTimeout));
            upstream.once('close', () => clearTimeout(connectTimeout));
            this.track(upstream);
            // Keep the upgrade handshake and frames intact instead of decoding WebSocket messages.
            socket.pause();
            upstream.once(connected, () => {
                const headers = incoming.rawHeaders.reduce((result, value, index, values) => {
                    return index % 2 ? result : `${result}${value}: ${values[index + 1]}\r\n`;
                }, '');
                upstream.write(`${incoming.method} ${incoming.url || '/'} HTTP/${incoming.httpVersion}\r\n${headers}\r\n`);
                if (head.length) {
                    this.touch('in', head.length);
                    upstream.write(head);
                }
                socket.on('data', (data) => this.touch('in', data.length));
                upstream.on('data', (data) => this.touch('out', data.length));
                socket.pipe(upstream);
                upstream.pipe(socket);
                socket.resume();
            });
            socket.on('error', () => upstream.destroy());
            upstream.on('error', () => socket.destroy());
            socket.on('close', () => upstream.destroy());
            upstream.on('close', () => socket.destroy());
        });
        this.server.on('clientError', (_error, socket) => socket.destroy());
        this.server.on('error', onError);
    }
    track(socket) {
        this.sockets.add(socket);
        socket.once('close', () => this.sockets.delete(socket));
    }
    touch(direction, bytes = 0) {
        this.lastActivityAt = Date.now();
        if (direction === 'in')
            this.bytesIn += bytes;
        if (direction === 'out')
            this.bytesOut += bytes;
    }
    listen(signal) {
        signal.throwIfAborted();
        this.opening = new Promise((resolve, reject) => {
            const failed = (error) => reject(error);
            this.server.once('error', failed);
            // Wait for the local bind before closing, so cancellation cannot leave a late listener.
            this.server.listen({ host: '127.0.0.1', port: 0 }, () => {
                this.server.removeListener('error', failed);
                if (signal.aborted || this.closed) {
                    reject(signal.reason || new Error('隧道转发已关闭'));
                    return;
                }
                const address = this.server.address();
                if (!address || typeof address === 'string') {
                    reject(new Error('无法启动隧道流量转发'));
                    return;
                }
                resolve(`http://127.0.0.1:${address.port}`);
            });
        });
        return this.opening;
    }
    close() {
        if (this.closed)
            return this.closed;
        this.closed = (async () => {
            await this.opening?.catch(() => { });
            await new Promise(resolve => {
                // An already stopped server reports ERR_SERVER_NOT_RUNNING here; it is also closed.
                this.server.close(() => resolve());
                for (const socket of this.sockets)
                    socket.destroy();
            });
        })();
        return this.closed;
    }
}
exports.TrafficProxy = TrafficProxy;
