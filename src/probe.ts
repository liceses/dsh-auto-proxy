/**
 * dsh-auto-proxy — network probe.
 *
 * Verifies that a URL is reachable through the resolved proxy (or directly),
 * using only node:net / node:tls / node:http — OpenSSL-based, so it is immune
 * to the Windows sandbox Schannel limitation and works inside any sandbox
 * mode. Techniques:
 *   - http/https proxy → CONNECT tunnel, then TLS.
 *   - socks5/socks5h proxy → RFC 1928 handshake, then TLS.
 *   - no proxy → direct TLS.
 */

import net from 'node:net'
import tls from 'node:tls'
import { request as httpRequest, type ClientRequest } from 'node:http'
import type { ResolvedProxy } from './shared-types.ts'

export interface ProbeResult {
  ok: boolean
  /** Elapsed milliseconds. */
  ms: number
  /** HTTP status when a TLS response arrived. */
  status?: number
  /** Failure description when not ok. */
  error?: string
  /** Route taken: direct | http-proxy | socks-proxy. */
  via: 'direct' | 'http-proxy' | 'socks-proxy'
}

interface ProxyEndpoint {
  kind: 'http' | 'socks'
  host: string
  port: number
}

interface Target {
  host: string
  port: number
  path: string
}

/** Parse a proxy URL into an endpoint, or null when unsupported/empty. */
function parseProxyUrl(url: string): ProxyEndpoint | null {
  if (url === '') return null
  let match = /^https?:\/\/([^/]+)$/i.exec(url)
  if (match) return splitHostPort(match[1], 8080, 'http')
  match = /^socks5h?:\/\/([^/]+)$/i.exec(url)
  if (match) return splitHostPort(match[1], 1080, 'socks')
  return null
}

function splitHostPort(authority: string, defaultPort: number, kind: 'http' | 'socks'): ProxyEndpoint {
  let host = authority
  let port = defaultPort
  const bracket = authority.indexOf(']')
  if (authority.startsWith('[') && bracket !== -1) {
    host = authority.slice(1, bracket)
    const rest = authority.slice(bracket + 1)
    if (rest.startsWith(':')) port = Number(rest.slice(1)) || defaultPort
  } else {
    const colon = authority.lastIndexOf(':')
    if (colon !== -1 && !authority.includes(':', colon + 1)) {
      const candidate = Number(authority.slice(colon + 1))
      if (Number.isInteger(candidate) && candidate > 0 && candidate < 65536) {
        host = authority.slice(0, colon)
        port = candidate
      }
    }
  }
  return { kind, host, port }
}

function parseTarget(url: string): Target | null {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null
  const host = parsed.hostname.replace(/^\[|\]$/g, '')
  const port = parsed.port !== '' ? Number(parsed.port) : parsed.protocol === 'https:' ? 443 : 80
  return { host, port, path: parsed.pathname + parsed.search || '/' }
}

/** NO_PROXY matching: entry may be `host`, `*.domain`, `domain` (suffix), or `:port`. */
export function matchesNoProxy(host: string, noProxy: string): boolean {
  const normalized = host.toLowerCase()
  return noProxy.split(',').map((entry) => entry.trim()).filter(Boolean).some((entry) => {
    const lower = entry.toLowerCase()
    if (lower === '*') return true
    const portIdx = lower.lastIndexOf(':')
    if (portIdx !== -1 && /^\d+$/.test(lower.slice(portIdx + 1))) return false
    const bare = lower.replace(/^\./, '').replace(/^\*\./, '')
    return normalized === bare || normalized.endsWith('.' + bare)
  })
}

/** One-shot TLS GET over an established socket, returning the HTTP status. */
function tlsGet(socket: net.Socket, servername: string, target: Target, deadline: number): Promise<{ status: number }> {
  return new Promise((resolve, reject) => {
    const tlsSocket = tls.connect({ socket, servername, rejectUnauthorized: false })
    let settled = false
    const fail = (error: Error): void => {
      if (settled) return
      settled = true
      tlsSocket.destroy()
      reject(error)
    }
    tlsSocket.on('error', fail)
    tlsSocket.on('secureConnect', () => {
      tlsSocket.write(`GET ${target.path} HTTP/1.1\r\nHost: ${target.host}\r\nUser-Agent: dsh-auto-proxy/0.1\r\nConnection: close\r\n\r\n`)
    })
    let buffer = ''
    tlsSocket.on('data', (chunk) => {
      buffer += chunk.toString('latin1')
      const headerEnd = buffer.indexOf('\r\n\r\n')
      if (headerEnd === -1) return
      if (settled) return
      settled = true
      const statusLine = buffer.slice(0, headerEnd).split('\r\n')[0] ?? ''
      const match = /^HTTP\/\d(?:\.\d)?\s+(\d{3})/.exec(statusLine)
      resolve({ status: match ? Number(match[1]) : 0 })
      tlsSocket.end()
    })
    tlsSocket.setTimeout(Math.max(0, deadline - Date.now()), () => fail(new Error('TLS/HTTP 超时')))
  })
}

function connect(host: string, port: number, deadline: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port })
    let settled = false
    const fail = (error: Error): void => {
      if (settled) return
      settled = true
      socket.destroy()
      reject(error)
    }
    socket.on('error', fail)
    socket.on('connect', () => {
      if (settled) return
      settled = true
      // The connect deadline must not outlive the handoff: a late fire would
      // destroy a socket the caller already owns.
      socket.setTimeout(0)
      resolve(socket)
    })
    socket.setTimeout(Math.max(0, deadline - Date.now()), () => fail(new Error('TCP 连接超时')))
  })
}

/** RFC 1928 SOCKS5 no-auth connect; resolves with the tunneled socket. */
async function socks5Connect(proxy: ProxyEndpoint, target: Target, deadline: number): Promise<net.Socket> {
  const socket = await connect(proxy.host, proxy.port, deadline)
  // Leftover-preserving reader: one chunk may carry several handshake replies,
  // and a naive read(N) would drop the bytes beyond N.
  let buffer = Buffer.alloc(0)
  let error: Error | null = null
  const waiters: Array<{ count: number; resolve(value: Buffer): void }> = []
  const pump = (): void => {
    while (waiters.length > 0 && buffer.length >= waiters[0]!.count) {
      const waiter = waiters.shift()!
      const take = buffer.subarray(0, waiter.count)
      buffer = buffer.subarray(waiter.count)
      waiter.resolve(take)
    }
  }
  const onData = (chunk: Buffer): void => {
    buffer = Buffer.concat([buffer, chunk])
    pump()
  }
  const onClose = (): void => {
    error = new Error('SOCKS5 连接被关闭')
    while (waiters.length > 0) {
      const waiter = waiters.shift()!
      waiter.resolve(Buffer.alloc(0))
    }
  }
  socket.on('data', onData)
  socket.on('close', onClose)
  socket.on('error', (err) => { error = err })
  socket.setTimeout(Math.max(0, deadline - Date.now()), () => {
    error = new Error('SOCKS5 握手超时')
    socket.destroy()
  })
  const read = (count: number): Promise<Buffer> => new Promise((resolve) => {
    if (error !== null) {
      resolve(Buffer.alloc(0))
      return
    }
    if (buffer.length >= count) {
      const take = buffer.subarray(0, count)
      buffer = buffer.subarray(count)
      resolve(take)
      return
    }
    waiters.push({ count, resolve })
  })

  socket.write(Buffer.from([0x05, 0x01, 0x00]))
  const method = await read(2)
  if (method.length < 2 || method[0] !== 0x05 || method[1] !== 0x00) {
    socket.destroy()
    throw new Error(`SOCKS5 协商失败 (method=${method[1] ?? '?'})`)
  }

  const host = Buffer.from(target.host)
  const port = Buffer.alloc(2)
  port.writeUInt16BE(target.port)
  socket.write(Buffer.concat([Buffer.from([0x05, 0x01, 0x00, 0x03, host.length]), host, port]))

  const reply = await read(4)
  if (reply.length < 4 || reply[0] !== 0x05 || reply[1] !== 0x00) {
    socket.destroy()
    throw new Error(`SOCKS5 连接失败 (code=${reply[1] ?? '?'})`)
  }
  const atyp = reply[3]!
  let addressLength: number
  if (atyp === 0x01) addressLength = 4
  else if (atyp === 0x03) addressLength = 1 + (await read(1))[0]!
  else if (atyp === 0x04) addressLength = 16
  else {
    socket.destroy()
    throw new Error(`SOCKS5 响应异常 (atyp=${atyp})`)
  }
  const tail = await read(addressLength + 2)
  if (tail.length < addressLength + 2) {
    socket.destroy()
    const failureMessage = (): string => (error === null ? 'SOCKS5 握手未完成' : error.message)
    throw new Error(failureMessage())
  }
  socket.removeListener('data', onData)
  socket.removeListener('close', onClose)
  socket.setTimeout(0)
  return socket
}

/** CONNECT tunnel through an http/https proxy; resolves with the tunneled socket. */
function httpConnect(proxy: ProxyEndpoint, target: Target, deadline: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const authority = `${target.host}:${target.port}`
    let req: ClientRequest
    try {
      req = httpRequest({
        host: proxy.host,
        port: proxy.port,
        method: 'CONNECT',
        path: authority,
        headers: { Host: authority },
      })
    } catch (error) {
      reject(error as Error)
      return
    }
    let settled = false
    const fail = (error: Error): void => {
      if (settled) return
      settled = true
      req.destroy()
      reject(error)
    }
    req.on('error', fail)
    req.setTimeout(Math.max(0, deadline - Date.now()), () => fail(new Error('CONNECT 隧道超时')))
    req.on('connect', (res, socket) => {
      if (res.statusCode !== 200) {
        fail(new Error(`代理拒绝 CONNECT（HTTP ${res.statusCode ?? '?'}）`))
        return
      }
      if (settled) return
      settled = true
      // The request deadline must not outlive the handoff.
      req.setTimeout(0)
      resolve(socket)
    })
    req.end()
  })
}

/** Run one probe. `proxyUrl` '' or null means direct. */
export async function probeUrl(proxy: ResolvedProxy, targetUrl: string, timeoutMs = 10000): Promise<ProbeResult> {
  const started = Date.now()
  const deadline = started + timeoutMs
  const target = parseTarget(targetUrl)
  if (target === null) {
    return { ok: false, ms: 0, error: `无法解析测试地址: ${targetUrl}`, via: 'direct' }
  }
  const choose = (): string => {
    if (proxy.https !== '' && target.port === 443) return proxy.https
    if (proxy.http !== '') return proxy.http
    return proxy.socks
  }
  const viaProxy = matchesNoProxy(target.host, proxy.noProxy) ? '' : choose()
  try {
    let socket: net.Socket
    let via: ProbeResult['via']
    if (viaProxy === '') {
      socket = await connect(target.host, target.port, deadline)
      via = 'direct'
    } else {
      const endpoint = parseProxyUrl(viaProxy)
      if (endpoint === null) {
        return { ok: false, ms: Date.now() - started, error: `不支持的代理地址: ${viaProxy}`, via: 'direct' }
      }
      if (endpoint.kind === 'socks') {
        socket = await socks5Connect(endpoint, target, deadline)
        via = 'socks-proxy'
      } else {
        socket = await httpConnect(endpoint, target, deadline)
        via = 'http-proxy'
      }
    }
    const { status } = await tlsGet(socket, target.host, target, deadline)
    return { ok: true, ms: Date.now() - started, status, via }
  } catch (error) {
    return { ok: false, ms: Date.now() - started, error: error instanceof Error ? error.message : String(error), via: viaProxy === '' ? 'direct' : (parseProxyUrl(viaProxy)?.kind === 'socks' ? 'socks-proxy' : 'http-proxy') }
  }
}
