/**
 * dsh-auto-proxy — proxy resolution core.
 *
 * Turns the `auto-proxy` settings section into a concrete proxy plan:
 *   - `manual`: use the configured http/https/socks/noProxy fields as-is.
 *   - `auto`:   detect the Windows system proxy (HKCU Internet Settings
 *               registry) first, falling back to the ambient HTTP(S)_PROXY /
 *               ALL_PROXY environment variables of the host process.
 *   - `off`:    no proxy.
 *
 * Everything here is pure Node + child_process; no DSH services are touched,
 * so the same functions are reusable by the tools, the webServer routes and
 * the shell-env contributor.
 */

import { execFile } from 'node:child_process'
import type { AutoProxySettings, ResolvedProxy } from './shared-types.ts'

/** Default settings values (mirrors the schemastery schema defaults). */
export const DEFAULT_SETTINGS: AutoProxySettings = {
  mode: 'auto',
  http: '',
  https: '',
  socks: '',
  noProxy: '',
  gitApply: false,
  testUrl: 'https://www.google.com/generate_204',
  pollSeconds: 30,
}

/** Normalize a raw host:port / URL string into a proxy URL with the given scheme. */
function toProxyUrl(raw: string, scheme: 'http' | 'https' | 'socks5h'): string {
  const value = raw.trim()
  if (value === '') return ''
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return value
  // Bare host:port (or bare host). IPv6 hosts come bracketed from the registry.
  const hasPort = /:\d+$/.test(value)
  const defaultPort = scheme === 'http' ? '80' : scheme === 'https' ? '443' : '1080'
  return `${scheme}://${value}${hasPort ? '' : `:${defaultPort}`}`
}

/**
 * The https slot of a proxy plan must carry an `http://` URL: Windows
 * registry `https=host:port` and `HTTPS_PROXY` both mean "forward HTTPS
 * traffic through this proxy", and the proxy's own protocol is HTTP
 * (CONNECT tunnelling). An `https://` prefix would make curl/git attempt a
 * TLS connection to the proxy itself — that is exactly the kind of value
 * that looks wrong to an agent and breaks real tools.
 */
function toHttpTunnelUrl(raw: string, defaultPort: number): string {
  const value = raw.trim()
  if (value === '') return ''
  if (/^https?:\/\//i.test(value)) {
    // Normalize https:// (or keep http://) to a plain http:// CONNECT URL.
    const url = new URL(value)
    return `http://${url.hostname}${url.port !== '' ? `:${url.port}` : ''}`
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return value
  const hasPort = /:\d+$/.test(value)
  return `http://${value}${hasPort ? '' : `:${defaultPort}`}`
}

/** Parse a Windows Internet Settings ProxyServer value into per-scheme raw entries. */
export function parseProxyServer(raw: string): { http: string; https: string; socks: string } {
  const parts = raw.split(';').map((part) => part.trim()).filter(Boolean)
  let http = ''
  let https = ''
  let socks = ''
  for (const part of parts) {
    const eq = part.indexOf('=')
    if (eq === -1) {
      // Bare host:port applies to both http and https.
      if (http === '') http = part
      if (https === '') https = part
      continue
    }
    const scheme = part.slice(0, eq).toLowerCase()
    const target = part.slice(eq + 1).trim()
    if (target === '') continue
    if (scheme === 'http') http = target
    else if (scheme === 'https') https = target
    else if (scheme === 'socks' || scheme === 'socks5' || scheme === 'socks5h') socks = target
  }
  return { http, https, socks }
}

/** Read one HKCU Internet Settings value via `reg query`. */
function readRegistryValue(name: 'ProxyEnable' | 'ProxyServer' | 'ProxyOverride'): Promise<string> {
  return new Promise((resolve) => {
    const key = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'
    execFile('reg', ['query', key, '/v', name], { timeout: 3000, windowsHide: true }, (error, stdout) => {
      if (error) return resolve('')
      // Lines look like: `    ProxyEnable    REG_DWORD    0x1`
      for (const line of stdout.split(/\r?\n/)) {
        if (!line.includes('REG_')) continue
        const tokens = line.trim().split(/\s+/)
        const value = tokens[tokens.length - 1] ?? ''
        if (value !== '') return resolve(value)
      }
      resolve('')
    })
  })
}

/** Detect the Windows system proxy (auto mode). Returns null when disabled/absent. */
async function detectWindowsProxy(): Promise<{ source: 'registry'; http: string; https: string; socks: string; noProxy: string } | null> {
  const [enable, server, overrideValue] = await Promise.all([
    readRegistryValue('ProxyEnable'),
    readRegistryValue('ProxyServer'),
    readRegistryValue('ProxyOverride'),
  ])
  if (enable !== '0x1' || server === '') return null
  const { http, https, socks } = parseProxyServer(server)
  const noProxy = overrideValue
    .split(';')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '' && entry !== '<local>')
    .join(',')
  return { source: 'registry', http, https, socks, noProxy }
}

/** Detect from the host process's ambient proxy environment variables. */
function detectFromEnv(env: NodeJS.ProcessEnv): { source: 'env'; http: string; https: string; socks: string; noProxy: string } | null {
  const http = env.HTTP_PROXY ?? env.http_proxy ?? ''
  const https = env.HTTPS_PROXY ?? env.https_proxy ?? ''
  const all = env.ALL_PROXY ?? env.all_proxy ?? ''
  const noProxy = env.NO_PROXY ?? env.no_proxy ?? ''
  if (http === '' && https === '' && all === '') return null
  return { source: 'env', http: http || '', https: https || '', socks: all || '', noProxy: noProxy || '' }
}

/** Build the concrete proxy plan for one settings section. */
export async function resolveProxy(settings: AutoProxySettings, env: NodeJS.ProcessEnv = process.env): Promise<ResolvedProxy> {
  if (settings.mode === 'off') {
    return { mode: 'off', source: 'none', http: '', https: '', socks: '', noProxy: '', ready: false, detail: 'off（未启用代理）' }
  }
  if (settings.mode === 'manual') {
    const http = toHttpTunnelUrl(settings.http, 80)
    const https = toHttpTunnelUrl(settings.https, 443)
    const socks = toProxyUrl(settings.socks, 'socks5h')
    const ready = http !== '' || https !== '' || socks !== ''
    const entries = [http && `HTTP ${http}`, https && `HTTPS ${https}`, socks && `SOCKS ${socks}`].filter(Boolean)
    return {
      mode: 'manual',
      source: 'manual',
      http,
      https,
      socks,
      noProxy: settings.noProxy.trim(),
      ready,
      detail: ready ? `manual（${entries.join('，')}）` : 'manual（未填写任何代理地址）',
    }
  }
  // auto
  if (process.platform === 'win32') {
    const fromRegistry = await detectWindowsProxy()
    if (fromRegistry !== null) {
      const http = toHttpTunnelUrl(fromRegistry.http, 80)
      const https = toHttpTunnelUrl(fromRegistry.https, 443)
      const socks = toProxyUrl(fromRegistry.socks, 'socks5h')
      const ready = http !== '' || https !== '' || socks !== ''
      return {
        mode: 'auto',
        source: 'registry',
        http,
        https,
        socks,
        noProxy: fromRegistry.noProxy,
        ready,
        detail: ready ? 'auto（Windows 系统代理）' : 'auto（系统代理已开启但无可解析地址）',
      }
    }
  }
  const fromEnv = detectFromEnv(env)
  if (fromEnv !== null) {
    const http = toHttpTunnelUrl(fromEnv.http, 80)
    const https = toHttpTunnelUrl(fromEnv.https, 443)
    const socks = toProxyUrl(fromEnv.socks, 'socks5h')
    const ready = http !== '' || https !== '' || socks !== ''
    return {
      mode: 'auto',
      source: 'env',
      http,
      https,
      socks,
      noProxy: fromEnv.noProxy,
      ready,
      detail: ready ? 'auto（环境变量）' : 'auto（环境变量存在但不可用）',
    }
  }
  return { mode: 'auto', source: 'none', http: '', https: '', socks: '', noProxy: '', ready: false, detail: 'auto（未检测到系统代理）' }
}

/** The ready-to-apply export block for shell commands. */
export function exportBlock(resolved: ResolvedProxy): string {
  const lines = [
    `export DSH_PROXY_MODE=${resolved.mode}`,
    `export DSH_PROXY_SOURCE=${resolved.source}`,
    `export DSH_PROXY_HTTP='${resolved.http}'`,
    `export DSH_PROXY_HTTPS='${resolved.https}'`,
    `export DSH_PROXY_SOCKS='${resolved.socks}'`,
    `export DSH_PROXY_NO_PROXY='${resolved.noProxy}'`,
    `export DSH_PROXY_READY=${resolved.ready ? '1' : '0'}`,
  ]
  if (resolved.http !== '') lines.push(`export HTTP_PROXY='${resolved.http}' http_proxy='${resolved.http}'`)
  if (resolved.https !== '') lines.push(`export HTTPS_PROXY='${resolved.https}' https_proxy='${resolved.https}'`)
  if (resolved.socks !== '') lines.push(`export ALL_PROXY='${resolved.socks}' all_proxy='${resolved.socks}'`)
  if (resolved.noProxy !== '') lines.push(`export NO_PROXY='${resolved.noProxy}' no_proxy='${resolved.noProxy}'`)
  return lines.join('\n')
}

/** The git-friendly proxy URL: prefer socks (DNS-safe), then https, then http. */
export function gitProxyUrl(resolved: ResolvedProxy): string {
  if (resolved.socks !== '') return resolved.socks
  if (resolved.https !== '') return resolved.https
  return resolved.http
}

/** Ready-to-use git advice line for the prompt and the proxy_env tool. */
export function buildGitAdvice(resolved: ResolvedProxy): string {
  if (!resolved.ready) return '当前无可用代理，git 不走代理；直连失败时先检查代理软件是否在运行。'
  if (resolved.socks !== '') {
    return 'git 走 socks5h（DNS 走代理防污染）：`git -c http.proxy=$DSH_PROXY_SOCKS -c https.proxy=$DSH_PROXY_SOCKS <子命令>`；或调用 proxy_git 工具一键应用/清除全局 git 代理。'
  }
  const url = resolved.https !== '' ? '$DSH_PROXY_HTTPS' : '$DSH_PROXY_HTTP'
  if (url === '$DSH_PROXY_HTTP') {
    return 'git 走 HTTP 代理：`git -c http.proxy=$DSH_PROXY_HTTP -c https.proxy=$DSH_PROXY_HTTP <子命令>`；或调用 proxy_git 工具一键应用/清除全局 git 代理。'
  }
  return 'git 走 HTTP 代理（HTTPS 流量经 CONNECT 隧道）：`git -c http.proxy=$DSH_PROXY_HTTPS -c https.proxy=$DSH_PROXY_HTTPS <子命令>`；或调用 proxy_git 工具一键应用/清除全局 git 代理。'
}

/**
 * Whether two plans differ in any value the shell/prompt consumes.
 * Used by the polling loop to detect system-proxy changes and decide whether
 * anything needs to be announced (the shell variables and prompt read the
 * current plan lazily, so swapping it is all an update needs).
 */
export function compareProxy(a: ResolvedProxy, b: ResolvedProxy): boolean {
  return a.mode === b.mode
    && a.source === b.source
    && a.http === b.http
    && a.https === b.https
    && a.socks === b.socks
    && a.noProxy === b.noProxy
    && a.ready === b.ready
}
