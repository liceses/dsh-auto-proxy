/**
 * dsh-auto-proxy — settings card (Settings > Plugins > 插件配置).
 *
 * Collapsible plugin card mirroring the official plugin-configuration chrome:
 * a header button (name + description + chevron) discloses the body in place;
 * the body holds the mode/fields/status/test controls; a footer carries the
 * discard/save actions. Unsaved edits are marked on the header while the card
 * is collapsed.
 */

import { useState, type JSX } from 'react'
import type { InjectFace } from '@deepseek-ai/dsh-client-ui-slots'
import type { AutoProxyCardFace, CardSnapshot } from './controller.ts'

/** Props the renderer binds for the auto-proxy card. */
export type AutoProxyCardProps = InjectFace<AutoProxyCardFace>

const MODE_LABELS: Record<CardSnapshot['mode'], string> = {
  off: '关闭',
  auto: '自动检测（Windows 系统代理 / 环境变量）',
  manual: '手动配置',
}

/** Chevron disclosure glyph (matches the official card's rotation affordance). */
function Chevron(props: { open: boolean }): JSX.Element {
  return (
    <svg
      className={props.open ? 'apx-chevron apx-chevronOpen' : 'apx-chevron'}
      width="16"
      height="16"
      viewBox="0 0 16 16"
      aria-hidden="true"
    >
      <path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

/** One text field row. */
function Field(props: { id: string; label: string; hint?: string; value: string; disabled: boolean; onChange(value: string): void }): JSX.Element {
  return (
    <div className="apx-field">
      <label className="apx-label" htmlFor={props.id}>{props.label}</label>
      <input
        id={props.id}
        className="apx-input"
        type="text"
        spellCheck={false}
        value={props.value}
        placeholder={props.hint}
        disabled={props.disabled}
        onChange={(event) => props.onChange(event.target.value)}
      />
    </div>
  )
}

/**
 * Render the card.
 * @param props - the store seat and actions.
 * @returns the card.
 */
export function AutoProxyCard(props: AutoProxyCardProps): JSX.Element {
  const state = props.useAutoProxyCard((snapshot) => snapshot)
  const { actions } = props
  const [open, setOpen] = useState(false)
  const disabled = !state.available || !state.writable

  return (
    <div className="apx-card">
      <button
        type="button"
        className="apx-header"
        aria-expanded={open}
        onClick={() => setOpen((previous) => !previous)}
      >
        <span className="apx-headText">
          <span className="apx-name">网络代理（auto-proxy）</span>
          <span className="apx-description">让 agent 的命令行网络访问走代理：自动注入 DSH_PROXY_* 变量并提供 proxy_env / proxy_test / proxy_git 工具，联网命令按指引应用即可，无需反复试错。</span>
        </span>
        {state.dirty && <span className="apx-pending">未保存</span>}
        <Chevron open={open} />
      </button>

      {open && (
        <div className="apx-body">
          <div className="apx-field">
            <label className="apx-label" htmlFor="auto-proxy-mode">模式</label>
            <select
              id="auto-proxy-mode"
              className="apx-select"
              value={state.mode}
              disabled={disabled}
              onChange={(event) => actions.setField('mode', event.target.value)}
            >
              {(Object.keys(MODE_LABELS) as CardSnapshot['mode'][]).map((mode) => (
                <option key={mode} value={mode}>{MODE_LABELS[mode]}</option>
              ))}
            </select>
          </div>

          {state.mode === 'auto' && (
            <div className="apx-status">
              {state.statusError !== null ? (
                <span className="apx-fail">状态获取失败：{state.statusError}</span>
              ) : state.status === null ? (
                <span>正在检测代理…</span>
              ) : (
                <>
                  <span>
                    状态：<span className={state.status.ready ? 'apx-ready' : 'apx-fail'}>{state.status.ready ? '已就绪' : '未检测到'}</span>
                    {' '}· {state.status.detail}
                  </span>
                  <span><code>{state.status.http !== '' ? `HTTP ${state.status.http}` : ''}</code></span>
                  <span><code>{state.status.https !== '' ? `HTTPS ${state.status.https}` : ''}</code></span>
                  <span><code>{state.status.socks !== '' ? `SOCKS ${state.status.socks}` : ''}</code></span>
                  <span>NO_PROXY：{state.status.noProxy !== '' ? <code>{state.status.noProxy}</code> : '无'}</span>
                  <span>git 全局代理：{state.status.gitApplied ? <span className="apx-ready">已应用</span> : '未应用'}</span>
                </>
              )}
            </div>
          )}

          {state.mode === 'manual' && (
            <>
              <Field
                id="auto-proxy-http"
                label="HTTP 代理"
                hint="如 http://127.0.0.1:8080（留空表示无）"
                value={state.http}
                disabled={disabled}
                onChange={(value) => actions.setField('http', value)}
              />
              <Field
                id="auto-proxy-https"
                label="HTTPS 代理"
                hint="如 http://127.0.0.1:8080（留空表示无）"
                value={state.https}
                disabled={disabled}
                onChange={(value) => actions.setField('https', value)}
              />
              <Field
                id="auto-proxy-socks"
                label="SOCKS 代理"
                hint="如 socks5://127.0.0.1:10808（留空表示无）"
                value={state.socks}
                disabled={disabled}
                onChange={(value) => actions.setField('socks', value)}
              />
              <Field
                id="auto-proxy-noproxy"
                label="NO_PROXY"
                hint="逗号分隔，如 localhost,127.0.0.1,.internal"
                value={state.noProxy}
                disabled={disabled}
                onChange={(value) => actions.setField('noProxy', value)}
              />
            </>
          )}

          <label className="apx-check">
            <input
              type="checkbox"
              checked={state.gitApply}
              disabled={disabled}
              onChange={(event) => actions.setField('gitApply', event.target.checked)}
            />
            同时应用到 git 全局配置（http.proxy / https.proxy，关闭时自动还原原值）
          </label>

          <div className="apx-row">
            <button type="button" className="apx-button" disabled={state.testing || disabled} onClick={() => actions.test()}>
              {state.testing ? '测试中…' : '测试连通性'}
            </button>
            <button type="button" className="apx-button" onClick={() => actions.refreshStatus()}>刷新检测</button>
            {state.test !== null && (
              <span className={state.test.ok ? 'apx-ready' : 'apx-fail'}>
                {state.test.ok
                  ? `连通正常（${state.test.via === 'direct' ? '直连' : state.test.via === 'http-proxy' ? 'HTTP 代理' : 'SOCKS 代理'}${state.test.status !== undefined ? `，HTTP ${state.test.status}` : ''}，${state.test.ms}ms）`
                  : `连通失败（${state.test.via === 'direct' ? '直连' : state.test.via === 'http-proxy' ? 'HTTP 代理' : 'SOCKS 代理'}，${state.test.ms}ms${state.test.error !== undefined ? `：${state.test.error}` : ''}）`}
              </span>
            )}
            {state.testError !== null && <span className="apx-fail">测试失败：{state.testError}</span>}
          </div>

          <div className="apx-footer">
            {state.failed && <p className="apx-footerNote apx-footerNoteError">保存失败，请重试。</p>}
            {!state.failed && state.loadError !== null && (
              <p className="apx-footerNote apx-footerNoteError">配置读取失败：{state.loadError}</p>
            )}
            {!state.failed && state.loadError === null && (
              <p className="apx-footerNote">
                {state.statusError !== null
                  ? `状态获取失败：${state.statusError}`
                  : state.status !== null
                    ? `${state.status.detail}${state.status.gitApplied ? ' · git 已应用代理' : ''}`
                    : ' '}
              </p>
            )}
            <button type="button" className="apx-button" disabled={!state.dirty || disabled} onClick={() => actions.discard()}>丢弃</button>
            <button type="button" className="apx-button apx-buttonPrimary" disabled={!state.dirty || disabled || state.saving} onClick={() => actions.save()}>
              {state.saving ? '保存中…' : '保存'}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
