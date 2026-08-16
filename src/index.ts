/**
 * dsh-auto-proxy — host half.
 *
 * Makes the agent's command-line network access proxy-aware and
 * deterministic, instead of the trial-and-error that wastes tokens:
 *
 *   1. Registers the `auto-proxy` settings namespace (Settings > Plugins >
 *      插件配置): mode off/auto/manual, manual proxy fields, gitApply, testUrl.
 *   2. Resolves the concrete proxy plan (Windows registry → env → manual).
 *   3. Registers a shell-env contributor so every bash/pwsh call the agent
 *      runs carries DSH_PROXY_* variables automatically.
 *   4. Registers a system-prompt section telling the agent how to use them.
 *   5. Registers model tools: proxy_env (ready export block), proxy_test
 *      (connectivity probe), proxy_git (apply/clear git global proxy).
 *   6. Serves /api/dsh-auto-proxy/status + /test for the settings card.
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import type { SettingsPathOp } from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-shell-env'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/cordis-plugin-timer'
import type { AutoProxySettings, ResolvedProxy } from './shared-types.ts'
import { buildGitAdvice, compareProxy, exportBlock, gitProxyUrl, resolveProxy } from './proxy.ts'
import { probeUrl } from './probe.ts'
import { applyGitProxy, currentHttpProxy, currentHttpsProxy, gitProxyStatus, restoreGitProxy } from './git.ts'
import { buildProxyPrompt } from './prompt.ts'

/** Stable cordis plugin name. */
export const name = 'auto-proxy'

/** Services required before the plugin can mount. */
export const inject = ['settings', 'shellEnv', 'systemPrompt', 'tools', 'webServer']

/** Settings namespace owned by this plugin. */
const SETTINGS_NS = settingsNamespace('auto-proxy')

/** Row config schema (also the settings namespace schema; row config is the composition base layer). */
const Config = z.object({
  mode: z.union([z.const('off'), z.const('auto'), z.const('manual')]).default('auto'),
  http: z.string().default(''),
  https: z.string().default(''),
  socks: z.string().default(''),
  noProxy: z.string().default(''),
  gitApply: z.boolean().default(false),
  testUrl: z.string().default('https://www.google.com/generate_204'),
  pollSeconds: z.number().default(30),
})

/**
 * Cache window for proxy re-resolution. 1s: the polling loop now owns the
 * de-duplication duty, so a lazy caller never serves a plan older than ~1s.
 */
const RESOLVE_TTL_MS = 1000

/**
 * Mount the plugin.
 * @param ctx - host plugin context.
 * @param config - row configuration (composition base for the settings namespace).
 */
export function apply(ctx: Context, config: unknown = {}): void {
  const scope = ctx.settings.register(SETTINGS_NS, Config, { base: config as Partial<AutoProxySettings> | undefined })

  // The settings service types the owner scope with schemastery's loose
  // ObjectS (fields may be null/undefined); our domain type is stricter.
  // One narrowing point keeps every consumer on AutoProxySettings.
  const readSettings = (): AutoProxySettings => scope.get() as unknown as AutoProxySettings

  // ---- proxy plan holder + refresh (TTL-cached) -------------------------------
  let current: ResolvedProxy = { mode: 'off', source: 'none', http: '', https: '', socks: '', noProxy: '', ready: false, detail: 'off' }
  let resolveChain: Promise<ResolvedProxy> = Promise.resolve(current)
  let lastResolveAt = 0

  const refresh = (): Promise<ResolvedProxy> => {
    const now = Date.now()
    if (now - lastResolveAt < RESOLVE_TTL_MS && resolveChain !== null) return resolveChain
    lastResolveAt = now
    resolveChain = resolveProxy(readSettings(), process.env).then((resolved) => {
      current = resolved
      return resolved
    })
    return resolveChain
  }
  void refresh()

  // ---- gitApply: mirror the plan into the git global config -------------------
  const handleGitApply = async (next: boolean, previous: boolean): Promise<void> => {
    if (next === previous) return
    const settings = readSettings()
    const resolved = await refresh()
    if (next) {
      const [prevHttp, prevHttps] = await Promise.all([currentHttpProxy(), currentHttpsProxy()])
      const outcome = await applyGitProxy(gitProxyUrl(resolved))
      if (outcome.ok) {
        await ctx.settings.mutate(SETTINGS_NS, [
          { op: 'set', path: ['_gitPrevHttp'], value: prevHttp },
          { op: 'set', path: ['_gitPrevHttps'], value: prevHttps },
        ])
        ctx.logger.info('auto-proxy: git 全局代理已应用 -> %s', gitProxyUrl(resolved) || '(清除)')
      } else {
        ctx.logger.warn('auto-proxy: git 全局代理应用失败: %s', outcome.error ?? '未知错误')
      }
    } else {
      const outcome = await restoreGitProxy(settings._gitPrevHttp, settings._gitPrevHttps)
      await ctx.settings.mutate(SETTINGS_NS, [
        { op: 'unset', path: ['_gitPrevHttp'] },
        { op: 'unset', path: ['_gitPrevHttps'] },
      ])
      ctx.logger.info('auto-proxy: git 全局代理已%s', outcome.ok ? '还原/清除' : `还原失败: ${outcome.error ?? '未知错误'}`)
    }
  }

  let prevGitApply = readSettings().gitApply
  scope.watch((next, previous) => {
    void refresh()
    const nextSettings = next as unknown as AutoProxySettings
    const previousSettings = previous as unknown as AutoProxySettings
    if (nextSettings.gitApply !== previousSettings.gitApply) {
      prevGitApply = nextSettings.gitApply
      void handleGitApply(nextSettings.gitApply, previousSettings.gitApply)
    }
  })
  // Apply at boot when the composition base already asks for it.
  void refresh().then(() => {
    if (readSettings().gitApply && !prevGitApply) {
      prevGitApply = true
      void handleGitApply(true, false)
    }
  })

  // ---- live polling: track system-proxy changes so the injected variables
  // and the prompt never go stale (e.g. the proxy software switches ports).
  // The current plan is swapped in place; every consumer (shell-env resolver,
  // prompt section, tools, routes) reads it lazily, so a change propagates to
  // the next shell call / model step with no further work. Uses the platform
  // timer inside a fiber effect (the cordis timer plugin is optional in some
  // deployments), so stop/update/undefine disposes the loop automatically.
  const pollSeconds = Math.max(1, Math.min(3600, readSettings().pollSeconds ?? 30))
  if (pollSeconds > 0) {
    ctx.effect(() => {
      const timer = setInterval(() => {
        void (async () => {
          try {
            const before = current
            const after = await refresh()
            if (!compareProxy(before, after)) {
              ctx.logger.info('auto-proxy: 系统代理变化 %s -> %s', before.detail, after.detail)
            }
          } catch (error) {
            ctx.logger.warn('auto-proxy: 轮询系统代理失败: %s', error instanceof Error ? error.message : String(error))
          }
        })()
      }, pollSeconds * 1000)
      return () => clearInterval(timer)
    }, 'auto-proxy: system-proxy poll')
  }

  // ---- shell-env contributor: DSH_PROXY_* into every shell call ---------------
  ctx.shellEnv.register({
    name: 'auto-proxy',
    variables: {
      DSH_PROXY_MODE: { description: 'auto-proxy 模式: off/auto/manual。联网命令前应用此配置。' },
      DSH_PROXY_SOURCE: { description: 'auto-proxy 来源: none/registry/env/manual。' },
      DSH_PROXY_HTTP: { description: 'auto-proxy HTTP 代理 URL（无代理时为空）。' },
      DSH_PROXY_HTTPS: { description: 'auto-proxy HTTPS 代理 URL（无代理时为空）。' },
      DSH_PROXY_SOCKS: { description: 'auto-proxy SOCKS 代理 URL（socks5h://，无代理时为空）。' },
      DSH_PROXY_NO_PROXY: { description: 'auto-proxy NO_PROXY 逗号分隔列表（可能为空）。' },
      DSH_PROXY_READY: { description: 'auto-proxy 代理是否就绪: 1=就绪 0=无。' },
    },
    resolve() {
      return {
        DSH_PROXY_MODE: current.mode,
        DSH_PROXY_SOURCE: current.source,
        DSH_PROXY_HTTP: current.http,
        DSH_PROXY_HTTPS: current.https,
        DSH_PROXY_SOCKS: current.socks,
        DSH_PROXY_NO_PROXY: current.noProxy,
        DSH_PROXY_READY: current.ready ? '1' : '0',
      }
    },
  })

  // ---- system-prompt section: deterministic network rules ---------------------
  ctx.systemPrompt.section({
    name: 'network-proxy',
    order: 150,
    text: () => buildProxyPrompt(current),
  })

  // ---- model tools --------------------------------------------------------------
  ctx.tools.register(defineTool({
    name: 'proxy_env',
    description: '查看当前代理配置，返回可直接应用到 shell 的 export 命令块与 git 代理建议。任何需要联网的命令（git、curl、wget、npm、pip、node fetch 等）之前，先调用本工具（或直接用命令内自动注入的 $DSH_PROXY_* 变量），不要自行猜测代理地址或反复试错。',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          mode: { type: 'string', description: 'off/auto/manual' },
          source: { type: 'string', description: '代理来源' },
          ready: { type: 'boolean', description: '是否已就绪' },
          http: { type: 'string' },
          https: { type: 'string' },
          socks: { type: 'string' },
          noProxy: { type: 'string' },
          block: { type: 'string', description: '可直接粘贴执行的 export 命令块' },
          git: { type: 'string', description: 'git 代理建议' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: renderEnvText(value) }],
    },
    async execute() {
      const resolved = await refresh()
      return {
        mode: resolved.mode,
        source: resolved.source,
        ready: resolved.ready,
        http: resolved.http,
        https: resolved.https,
        socks: resolved.socks,
        noProxy: resolved.noProxy,
        block: exportBlock(resolved),
        git: buildGitAdvice(resolved),
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'proxy_test',
    description: '测试目标 URL 是否可连通（自动选择 走代理/直连，依据 NO_PROXY 与可用代理），返回状态码、耗时与路径。网络请求失败或超时时调用一次本工具定位问题（代理不可用/目标被墙/直连可用等），根据结果决定下一步，禁止连续盲目重试。',
    parameters: {
      url: { type: 'string', description: '测试目标 URL，缺省使用配置中的 testUrl。' },
      timeoutMs: { type: 'integer', description: '超时毫秒数，缺省 10000。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', description: '是否成功拿到 HTTP 响应' },
          via: { type: 'string', description: 'direct/http-proxy/socks-proxy' },
          ms: { type: 'number', description: '耗时毫秒' },
          status: { type: 'number', description: 'HTTP 状态码' },
          error: { type: 'string', description: '失败原因' },
          proxy: {
            type: 'object',
            additionalProperties: false,
            properties: {
              mode: { type: 'string' },
              source: { type: 'string' },
              http: { type: 'string' },
              https: { type: 'string' },
              socks: { type: 'string' },
              noProxy: { type: 'string' },
            },
          },
        },
      },
      render: (_args, value) => [{ type: 'text', text: renderTestText(value) }],
    },
    async execute(args) {
      const resolved = await refresh()
      const target = (args.url ?? '').trim() !== '' ? args.url!.trim() : readSettings().testUrl
      const result = await probeUrl(resolved, target, args.timeoutMs ?? 10000)
      return {
        ok: result.ok,
        via: result.via,
        ms: result.ms,
        ...(result.status !== undefined ? { status: result.status } : {}),
        ...(result.error !== undefined ? { error: result.error } : {}),
        proxy: {
          mode: resolved.mode,
          source: resolved.source,
          http: resolved.http,
          https: resolved.https,
          socks: resolved.socks,
          noProxy: resolved.noProxy,
        },
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'proxy_git',
    description: '一键应用/清除 git 全局代理（http.proxy/https.proxy）。apply=true 时把当前解析到的代理写入 git 全局配置并记住原值（以便还原）；apply=false 时还原原值或清除。用于 git clone/fetch 长期受限的场景；单次命令则用 git -c http.proxy=... 即可。',
    parameters: {
      apply: { type: 'boolean', required: true, description: 'true=应用当前代理到 git 全局配置；false=还原/清除' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          applied: { type: 'boolean', description: '操作后 git 全局是否带代理' },
          value: { type: 'string', description: '操作后 git 全局 http.proxy 值' },
          error: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: renderGitText(value) }],
    },
    async execute(args) {
      const resolved = await refresh()
      if (args.apply) {
        const [prevHttp, prevHttps] = await Promise.all([currentHttpProxy(), currentHttpsProxy()])
        const outcome = await applyGitProxy(gitProxyUrl(resolved))
        if (outcome.ok) {
          await ctx.settings.mutate(SETTINGS_NS, [
            { op: 'set', path: ['_gitPrevHttp'], value: prevHttp },
            { op: 'set', path: ['_gitPrevHttps'], value: prevHttps },
          ])
        } else {
          return { ok: false, applied: false, value: '', error: outcome.error ?? '未知错误' }
        }
      } else {
        const settings = readSettings()
        const outcome = await restoreGitProxy(settings._gitPrevHttp, settings._gitPrevHttps)
        await ctx.settings.mutate(SETTINGS_NS, [
          { op: 'unset', path: ['_gitPrevHttp'] },
          { op: 'unset', path: ['_gitPrevHttps'] },
        ])
        if (!outcome.ok) return { ok: false, applied: false, value: '', error: outcome.error ?? '未知错误' }
      }
      const status = await gitProxyStatus()
      return { ok: true, applied: status.applied, value: status.value }
    },
  }))

  // ---- webServer routes for the settings card ----------------------------------
  const sendJson = (res: import('node:http').ServerResponse, body: unknown, status = 200): void => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify(body))
  }

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/api/dsh-auto-proxy/status',
    handler: (_req, res) => {
      void (async () => {
        try {
          const resolved = await refresh()
          const git = await gitProxyStatus()
          sendJson(res, {
            mode: resolved.mode,
            source: resolved.source,
            http: resolved.http,
            https: resolved.https,
            socks: resolved.socks,
            noProxy: resolved.noProxy,
            ready: resolved.ready,
            detail: resolved.detail,
            gitApplied: git.applied,
            gitValue: git.value,
          })
        } catch (error) {
          sendJson(res, { error: error instanceof Error ? error.message : String(error) }, 500)
        }
      })()
    },
  }), 'auto-proxy: status route')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/api/dsh-auto-proxy/settings',
    handler: (req, res) => {
      void (async () => {
        try {
          if (req.method === 'GET') {
            const value = readSettings()
            const { _gitPrevHttp: _prevHttp, _gitPrevHttps: _prevHttps, ...visible } = value
            sendJson(res, { value: visible, writable: ctx.settings.writable })
            return
          }
          if (req.method === 'POST') {
            let body = ''
            req.on('data', (chunk: Buffer) => {
              body += chunk.toString('utf8')
              if (body.length > 8192) req.destroy()
            })
            await new Promise<void>((resolve) => req.on('end', () => resolve()))
            const parsed = JSON.parse(body === '' ? '{}' : body) as {
              set?: Record<string, string | boolean>
              unset?: string[]
            }
            if (parsed === null || typeof parsed !== 'object') throw new Error('请求体必须是 JSON 对象')
            const ops: SettingsPathOp[] = []
            if (parsed.set !== undefined) {
              for (const [field, value] of Object.entries(parsed.set)) {
                if (typeof value !== 'string' && typeof value !== 'boolean') throw new Error(`字段 ${field} 的值必须是字符串或布尔`)
                ops.push({ op: 'set', path: [field], value })
              }
            }
            if (parsed.unset !== undefined) {
              for (const field of parsed.unset) {
                if (typeof field !== 'string') throw new Error('unset 字段名必须是字符串')
                ops.push({ op: 'unset', path: [field] })
              }
            }
            if (ops.length === 0) {
              sendJson(res, { ok: true })
              return
            }
            await ctx.settings.mutate(SETTINGS_NS, ops)
            const value = scope.get()
            const { _gitPrevHttp: _prevHttp, _gitPrevHttps: _prevHttps, ...visible } = value
            sendJson(res, { ok: true, value: visible, writable: ctx.settings.writable })
            return
          }
          sendJson(res, { error: `不支持的方法 ${req.method ?? '?'}` }, 405)
        } catch (error) {
          sendJson(res, { error: error instanceof Error ? error.message : String(error) }, 400)
        }
      })()
    },
  }), 'auto-proxy: settings route')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/api/dsh-auto-proxy/test',
    handler: (req, res) => {
      void (async () => {
        try {
          let body = ''
          req.on('data', (chunk: Buffer) => {
            body += chunk.toString('utf8')
            if (body.length > 4096) req.destroy()
          })
          await new Promise<void>((resolve) => req.on('end', () => resolve()))
          let url: string | undefined
          try {
            const parsed = JSON.parse(body === '' ? '{}' : body) as { url?: string }
            if (typeof parsed.url === 'string' && parsed.url.trim() !== '') url = parsed.url.trim()
          } catch {
            // non-JSON body: ignore
          }
          const resolved = await refresh()
          const result = await probeUrl(resolved, url ?? readSettings().testUrl, 10000)
          sendJson(res, {
            ok: result.ok,
            via: result.via,
            ms: result.ms,
            ...(result.status !== undefined ? { status: result.status } : {}),
            ...(result.error !== undefined ? { error: result.error } : {}),
            proxy: {
              mode: resolved.mode,
              source: resolved.source,
              http: resolved.http,
              https: resolved.https,
              socks: resolved.socks,
              noProxy: resolved.noProxy,
            },
          })
        } catch (error) {
          sendJson(res, { error: error instanceof Error ? error.message : String(error) }, 500)
        }
      })()
    },
  }), 'auto-proxy: test route')
}

// ---- tool text renderers ------------------------------------------------------

interface EnvValue { mode?: string; source?: string; ready?: boolean; http?: string; https?: string; socks?: string; noProxy?: string; block?: string; git?: string }

function renderEnvText(value: EnvValue): string {
  const lines = [
    `代理状态: 模式=${value.mode ?? '?'} 来源=${value.source ?? '?'} 就绪=${value.ready === true ? '是' : '否'}`,
    `HTTP=${value.http || '无'} HTTPS=${value.https || '无'} SOCKS=${value.socks || '无'} NO_PROXY=${value.noProxy || '无'}`,
    '',
    '可直接执行的 export 块:',
    value.block ?? '',
    '',
    value.git ?? '',
  ]
  return lines.join('\n')
}

interface TestValue { ok?: boolean; via?: string; ms?: number; status?: number; error?: string; proxy?: { mode?: string; source?: string; http?: string; https?: string; socks?: string; noProxy?: string } }

function renderTestText(value: TestValue): string {
  const proxy = value.proxy
  const lines = [
    value.ok === true
      ? `连通正常: ${value.via === 'direct' ? '直连' : value.via === 'http-proxy' ? 'HTTP 代理' : 'SOCKS 代理'}，HTTP ${value.status ?? '?'}，耗时 ${value.ms ?? '?'}ms`
      : `连通失败: 路径=${value.via === 'direct' ? '直连' : value.via === 'http-proxy' ? 'HTTP 代理' : 'SOCKS 代理'}，耗时 ${value.ms ?? '?'}ms${value.error ? `，原因: ${value.error}` : ''}`,
    `代理: 模式=${proxy?.mode ?? '?'} 来源=${proxy?.source ?? '?'} HTTP=${proxy?.http || '无'} HTTPS=${proxy?.https || '无'} SOCKS=${proxy?.socks || '无'} NO_PROXY=${proxy?.noProxy || '无'}`,
  ]
  if (value.ok !== true) {
    lines.push('建议: 若代理不可用，检查代理软件是否运行/端口是否正确；若直连失败而代理可用，先应用代理（proxy_env 的 export 块）再重试。')
  }
  return lines.join('\n')
}

interface GitValue { ok?: boolean; applied?: boolean; value?: string; error?: string }

function renderGitText(value: GitValue): string {
  if (value.ok !== true) return `git 代理操作失败: ${value.error ?? '未知错误'}`
  return value.applied === true
    ? `git 全局代理已应用: http.proxy=${value.value ?? ''}`
    : 'git 全局代理已清除/还原（当前未带代理）'
}
