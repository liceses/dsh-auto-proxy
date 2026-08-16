/**
 * dsh-auto-proxy — git global proxy management.
 *
 * `gitApply` in the settings section lets the user mirror the resolved proxy
 * into the git global configuration (http.proxy / https.proxy). Enabling
 * stores the previous values so disabling can restore them.
 */

import { execFile } from 'node:child_process'

export interface GitOutcome {
  ok: boolean
  error?: string
}

function runGit(args: string[], timeoutMs = 10000): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile('git', args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      if (error === null) {
        resolve({ code: 0, stdout, stderr })
        return
      }
      resolve({ code: typeof error.code === 'number' ? error.code : 1, stdout, stderr: stderr || String(error.message ?? error) })
    })
  })
}

/** Current global http.proxy value, '' when unset. */
export async function currentHttpProxy(): Promise<string> {
  const { code, stdout } = await runGit(['config', '--global', '--get', 'http.proxy'])
  return code === 0 ? stdout.trim() : ''
}

/** Current global https.proxy value, '' when unset. */
export async function currentHttpsProxy(): Promise<string> {
  const { code, stdout } = await runGit(['config', '--global', '--get', 'https.proxy'])
  return code === 0 ? stdout.trim() : ''
}

/** Whether the global git config currently carries a proxy. */
export async function gitProxyStatus(): Promise<{ applied: boolean; value: string }> {
  const value = await currentHttpProxy()
  return { applied: value !== '', value }
}

/**
 * Apply the resolved proxy to the git global config. When `proxyUrl` is '',
 * remove any http.proxy/https.proxy entries instead.
 */
export async function applyGitProxy(proxyUrl: string): Promise<GitOutcome> {
  if (proxyUrl === '') {
    const unset = await runGit(['config', '--global', '--unset-all', 'http.proxy'])
    await runGit(['config', '--global', '--unset-all', 'https.proxy'])
    if (unset.code !== 0 && unset.code !== 5 && unset.code !== 1) {
      return { ok: false, error: `git 清除代理失败: ${unset.stderr.trim()}` }
    }
    return { ok: true }
  }
  const http = await runGit(['config', '--global', 'http.proxy', proxyUrl])
  if (http.code !== 0) return { ok: false, error: `git 设置 http.proxy 失败: ${http.stderr.trim()}` }
  const https = await runGit(['config', '--global', 'https.proxy', proxyUrl])
  if (https.code !== 0) return { ok: false, error: `git 设置 https.proxy 失败: ${https.stderr.trim()}` }
  return { ok: true }
}

/** Restore previous git global proxy values, or unset when none were stored. */
export async function restoreGitProxy(prevHttp?: string, prevHttps?: string): Promise<GitOutcome> {
  const setOrUnset = async (key: string, prev?: string): Promise<GitOutcome> => {
    if (prev !== undefined && prev !== '') {
      const outcome = await runGit(['config', '--global', key, prev])
      return outcome.code === 0 ? { ok: true } : { ok: false, error: `git 还原 ${key} 失败: ${outcome.stderr.trim()}` }
    }
    const outcome = await runGit(['config', '--global', '--unset-all', key])
    if (outcome.code === 0 || outcome.code === 5 || outcome.code === 1) return { ok: true }
    return { ok: false, error: `git 清除 ${key} 失败: ${outcome.stderr.trim()}` }
  }
  const http = await setOrUnset('http.proxy', prevHttp)
  if (!http.ok) return http
  return setOrUnset('https.proxy', prevHttps)
}
