/**
 * dsh-auto-proxy — system-prompt guidance builder.
 *
 * A short, rule-shaped section injected into the agent's system prompt so
 * network access through the proxy is deterministic: the agent applies the
 * pre-injected DSH_PROXY_* variables (or the proxy_env tool's export block)
 * before any network command instead of trial-and-error.
 *
 * The section is written to preempt the confusion a proxy setup can cause an
 * agent: it explains why the values look the way they do (one mixed port,
 * http:// prefix on the HTTPS slot, Windows-style NO_PROXY wildcards) so the
 * agent does not second-guess a healthy configuration.
 */

import type { ResolvedProxy } from './shared-types.ts'
import { buildGitAdvice, exportBlock } from './proxy.ts'

/** Explain the shape of the current plan so the agent does not doubt it. */
function trustNote(resolved: ResolvedProxy): string {
  const notes: string[] = []
  if (resolved.source === 'registry') {
    notes.push('该配置来自 Windows 系统代理设置（v2RayN/Clash 等代理软件会自动写入），是可信来源，不要怀疑')
  } else if (resolved.source === 'env') {
    notes.push('该配置来自宿主进程环境变量，是可信来源，不要怀疑')
  } else if (resolved.source === 'manual') {
    notes.push('该配置是用户在设置页手动填写的，是可信来源，不要怀疑')
  }
  if (resolved.http !== '' && resolved.https !== '' && resolved.http === resolved.https) {
    notes.push(`HTTP 与 HTTPS 共用同一代理地址（${resolved.http}）是代理软件常见的混合端口，不是笔误`)
  }
  if (resolved.https !== '' && resolved.socks === '' && resolved.http !== resolved.https) {
    notes.push('HTTPS 代理用 http:// 前缀表示“通过该 HTTP 代理以 CONNECT 隧道转发 HTTPS 流量”，不是笔误')
  }
  if (resolved.noProxy !== '') {
    notes.push('NO_PROXY 含 Windows 通配写法（如 127.*、172.16.*），多数工具按子网/后缀解释；某工具不识别时再临时精简该变量')
  }
  return notes.join('；')
}

/** Build the `network-proxy` prompt section text for the current plan. */
export function buildProxyPrompt(resolved: ResolvedProxy): string {
  const lines = [
    '## 网络代理 (auto-proxy)',
    `当前代理: 模式=${resolved.mode}，来源=${resolved.source}${resolved.ready ? `，HTTP=${resolved.http || '无'}，HTTPS=${resolved.https || '无'}，SOCKS=${resolved.socks || '无'}，NO_PROXY=${resolved.noProxy || '无'}` : ''}`,
  ]
  const note = trustNote(resolved)
  if (note !== '') lines.push(`可信说明: ${note}。`)
  lines.push('规则（联网前必须执行，不要反复试错）：')
  if (resolved.ready) {
    lines.push(
      `1. 每个 shell 命令已自动注入 DSH_PROXY_MODE/SOURCE/HTTP/HTTPS/SOCKS/NO_PROXY/READY 变量；需要联网的 bash/pwsh 命令先应用（空值变量无需理会）：\n${exportBlock(resolved)}`,
      '2. 也可调用 proxy_env 工具获取现成的 export 块与 git 建议（一次调用，禁止自行猜测代理端口）。',
      `3. ${buildGitAdvice(resolved)}`,
    )
  } else {
    lines.push(
      '1. 当前未检测到可用代理；直接网络请求大概率失败或超时。先调用 proxy_env 查看状态，再调用 proxy_test 确认连通性，不要盲目重试。',
      '2. 若确有代理（如 v2RayN 等），可在 设置 > 插件 > 插件配置 > auto-proxy 中改为 manual 模式并填写地址。',
    )
  }
  lines.push(
    '4. Windows 沙箱硬限制：curl.exe / PowerShell Invoke-WebRequest / .NET HttpClient 的 HTTPS 在受限沙箱内必然报 SEC_E_NO_CREDENTIALS——抓取请改用 OpenSSL 系工具（node 的 fetch、git、npm），或按沙箱规则升级执行。',
    '5. 网络失败时调用一次 proxy_test 定位问题；若 proxy_test 通过，该代理即可放心使用，不要怀疑端口或反复更换方案。',
  )
  return lines.join('\n')
}
