const assert = require('node:assert/strict')
const { test } = require('node:test')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')
const { once } = require('node:events')
const http = require('node:http')
const https = require('node:https')
const net = require('node:net')
const tls = require('node:tls')
const { TrafficProxy } = require('../lib/proxy')

async function listen(server, host = '127.0.0.1') {
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, host, resolve)
  })
  return server.address().port
}

function close(server) {
  return new Promise(resolve => {
    server.close(resolve)
    server.closeAllConnections?.()
  })
}

function request(url, options = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, options, res => {
      let body = ''
      res.on('data', chunk => body += chunk)
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }))
      res.on('error', reject)
    })
    req.setTimeout(3000, () => req.destroy(new Error('request timeout')))
    req.on('error', reject)
    req.end(options.body)
  })
}

test('HTTP forwarding preserves paths, bodies and cookies, but excludes probes from activity', { timeout: 10000 }, async () => {
  const backend = http.createServer((req, res) => {
    let body = ''
    req.on('data', chunk => body += chunk)
    req.on('end', () => {
      res.setHeader('set-cookie', ['a=1; HttpOnly', 'b=2'])
      res.end(JSON.stringify({ path: req.url, host: req.headers.host, removed: req.headers['x-remove'], body }))
    })
  })
  const port = await listen(backend)
  const proxy = new TrafficProxy(`http://127.0.0.1:${port}`, '/probe', 'probe-id', assert.fail)
  try {
    const address = await proxy.listen(new AbortController().signal)
    const activity = proxy.lastActivityAt
    const probe = await request(`${address}/probe`)
    assert.equal(probe.status, 204)
    assert.equal(probe.headers['x-koishi-cf-tunnel'], 'probe-id')
    assert.equal(proxy.requests, 0)
    assert.equal(proxy.lastActivityAt, activity)
    const response = await request(`${address}/route?q=1`, {
      method: 'POST', headers: { host: 'public.trycloudflare.com', connection: 'x-remove', 'x-remove': 'secret' }, body: 'hello',
    })
    assert.equal(response.status, 200)
    assert.deepEqual(JSON.parse(response.body), { path: '/route?q=1', host: 'public.trycloudflare.com', body: 'hello' })
    assert.deepEqual(response.headers['set-cookie'], ['a=1; HttpOnly', 'b=2'])
    assert.equal(proxy.requests, 1)
    assert.equal(proxy.bytesIn, 5)
    assert.equal(proxy.bytesOut, Buffer.byteLength(response.body))
  } finally {
    await proxy.close()
    await close(backend)
  }
})

test('WebSocket upgrades preserve the initial frames and close with the proxy', { timeout: 10000 }, async () => {
  const backend = http.createServer()
  backend.on('upgrade', (_req, socket, head) => {
    socket.on('error', () => {})
    socket.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n')
    if (head.length) socket.write(head)
    socket.pipe(socket)
  })
  const port = await listen(backend)
  const proxy = new TrafficProxy(`http://127.0.0.1:${port}`, '/probe', 'probe-id', assert.fail)
  let socket
  try {
    const address = await proxy.listen(new AbortController().signal)
    socket = net.createConnection({ host: '127.0.0.1', port: Number(new URL(address).port) })
    await once(socket, 'connect')
    const echoed = new Promise((resolve, reject) => {
      let bytes = ''
      socket.setTimeout(3000, () => socket.destroy(new Error('upgrade timeout')))
      socket.on('data', chunk => { bytes += chunk; if (bytes.includes('payload')) resolve(bytes) })
      socket.on('error', reject)
    })
    socket.write('GET /socket HTTP/1.1\r\nHost: public.trycloudflare.com\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\npayload')
    assert.match(await echoed, /101 Switching Protocols/)
    assert.equal(proxy.requests, 1)
    assert.equal(proxy.bytesIn, 7)
    const closed = once(socket, 'close')
    await proxy.close()
    await closed
  } finally {
    socket?.destroy()
    await proxy.close()
    await close(backend)
  }
})

// This public fixture key is exclusively for the loopback test server.
const key = readFileSync(join(__dirname, 'fixtures/localhost-key.pem'))
const cert = readFileSync(join(__dirname, 'fixtures/localhost-cert.pem'))
for (const hostname of ['127.0.0.1', 'localhost']) {
  test(`HTTPS validates ${hostname} independently of the public Host`, { timeout: 10000 }, async t => {
    const connect = tls.connect
    // Trust only the test CA; keep Node's real TLS handshake and hostname checks.
    t.mock.method(tls, 'connect', (options, ...args) => connect({ ...options, ca: cert }, ...args))
    const backend = https.createServer({ key, cert }, (req, res) => res.end(req.headers.host))
    const port = await listen(backend, hostname)
    const proxy = new TrafficProxy(`https://${hostname}:${port}`, '/probe', 'probe-id', assert.fail)
    try {
      const address = await proxy.listen(new AbortController().signal)
      const response = await request(address, { headers: { host: 'public.trycloudflare.com' } })
      assert.equal(response.status, 200)
      assert.equal(response.body, 'public.trycloudflare.com')
    } finally {
      await proxy.close()
      await close(backend)
    }
  })
}

test('HTTPS still rejects a trusted certificate for the wrong upstream IP', { timeout: 10000 }, async t => {
  const connect = tls.connect
  t.mock.method(tls, 'connect', (options, ...args) => connect({ ...options, ca: cert }, ...args))
  const backend = https.createServer({ key, cert }, (_req, res) => res.end('must not be reached'))
  const port = await listen(backend, '127.0.0.2')
  const proxy = new TrafficProxy(`https://127.0.0.2:${port}`, '/probe', 'probe-id', assert.fail)
  try {
    const address = await proxy.listen(new AbortController().signal)
    const response = await request(address, { headers: { host: 'localhost' } })
    assert.equal(response.status, 502)
  } finally {
    await proxy.close()
    await close(backend)
  }
})
