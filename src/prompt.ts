/**
 * dsh-auto-proxy — system-prompt guidance builder.
 *
 * A short, rule-shaped section injected into the agent's system prompt so
 * network access through the proxy is deterministic: the agent applies the
 * pre-injected DSH_PROXY_* variables (or the proxy_env tool's export block)
 * before any network command instead of trial-and-error.
 */

import type { ResolvedProxy } from './shared-types.ts'
import { exportBlock } from './proxy.ts'

/** Build the `network-proxy` prompt section text for the current plan. */
export function buildProxyPrompt(resolved: ResolvedProxy): string {
  const lines = [
    '## 网络代理 (auto-proxy)',
    `当前代理: 模式=${resolved.mode}，来源=${resolved.source}${resolved.ready ? `，HTTP=${resolved.http || '无'}，HTTPS=${resolved.https || '无'}，SOCKS=${resolved.socks || '无'}，NO_PROXY=${resolved.noProxy || '无'}` : ''}`,
    '规则（联网前必须执行，不要反复试错）：',
  ]
  if (resolved.ready) {
    lines.push(
      `1. 每个 shell 命令已自动注入 DSH_PROXY_MODE/SOURCE/HTTP/HTTPS/SOCKS/NO_PROXY/READY 变量；需要联网的 bash/pwsh 命令先执行：\n${exportBlock(resolved)}`,
      '2. 也可先调用 proxy_env 工具获取现成的 export 块与 git 建议（一次调用，禁止自行猜测代理端口）。',
      '3. git 网络操作建议 socks5h 代理（DNS 走代理防污染）：`git -c http.proxy=$DSH_PROXY_SOCKS -c https.proxy=$DSH_PROXY_SOCKS <子命令>`；或调用 proxy_git 工具一键应用/清除全局 git 代理。',
    )
  } else {
    lines.push(
      '1. 当前未检测到可用代理；直接网络请求大概率失败或超时。先调用 proxy_env 查看状态，再调用 proxy_test 确认连通性，不要盲目重试。',
      '2. 若确有代理（如 v2RayN 等），可在 设置 > 插件 > 插件配置 > auto-proxy 中改为 manual 模式并填写地址。',
    )
  }
  lines.push(
    '4. Windows 沙箱硬限制：curl.exe / PowerShell Invoke-WebRequest / .NET HttpClient 的 HTTPS 在受限沙箱内必然报 SEC_E_NO_CREDENTIALS——抓取请改用 OpenSSL 系工具（node 的 fetch、git、npm），或按沙箱规则升级执行。',
    '5. 网络失败时调用一次 proxy_test 定位问题（它报告走代理/直连的连通性与耗时），根据结果决定下一步，禁止连续盲试。',
  )
  return lines.join('\n')
}
