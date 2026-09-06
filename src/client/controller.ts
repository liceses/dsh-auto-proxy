/**
 * dsh-auto-proxy — browser half controller.
 *
 * rc7 removed the settings-namespace whitelist: every registered namespace is
 * served through the official `settingsScope` transport, so this card binds
 * the `auto-proxy` namespace and reads/writes it through the scope (revision
 * fencing, host validation and persistence included) instead of a self-built
 * REST channel. Live proxy status and connectivity probes are runtime data —
 * not settings — and still come from the host's /api/dsh-auto-proxy/status
 * and /api/dsh-auto-proxy/test routes.
 * All state mirrors into one snapshot store the card renders through.
 */

import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SettingsScope } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { AutoProxySettings } from '../shared-types.ts'

/** Live proxy status served by the host. */
export interface ProxyStatusView {
  mode: string
  source: string
  http: string
  https: string
  socks: string
  noProxy: string
  ready: boolean
  detail: string
  gitApplied: boolean
  gitValue: string
}

/** One probe run as shown in the card. */
export interface ProbeView {
  ok: boolean
  via: string
  ms: number
  status?: number
  error?: string
}

/** Everything the card renders. */
export interface CardSnapshot {
  available: boolean
  writable: boolean
  saving: boolean
  failed: boolean
  dirty: boolean
  mode: 'off' | 'auto' | 'manual'
  http: string
  https: string
  socks: string
  noProxy: string
  gitApply: boolean
  loadError: string | null
  status: ProxyStatusView | null
  statusError: string | null
  testing: boolean
  test: ProbeView | null
  testError: string | null
}

/** Actions the card's slot entry injects. */
export interface CardActions {
  setField(field: string, value: string | boolean): void
  save(): void
  discard(): void
  refreshStatus(): void
  test(): void
}

/** The registration-side face: a store seat (bound as useAutoProxyCard) + actions. */
export interface AutoProxyCardFace {
  hooks: { autoProxyCard: SnapshotStore<CardSnapshot> }
  actions: CardActions
}

const EMPTY: AutoProxySettings = {
  mode: 'auto',
  http: '',
  https: '',
  socks: '',
  noProxy: '',
  gitApply: false,
  testUrl: 'https://www.google.com/generate_204',
  pollSeconds: 30,
}

/** Bridge the bound `auto-proxy` settings scope onto the card's snapshot store. */
export class AutoProxyCardController {
  private readonly scope: SettingsScope<AutoProxySettings>
  private readonly store: SnapshotStore<CardSnapshot>
  private readonly staged = new Map<string, string | boolean>()
  private status: ProxyStatusView | null = null
  private statusError: string | null = null
  private testing = false
  private testResult: ProbeView | null = null
  private testError: string | null = null
  private saving = false
  private failed = false
  private disposed = false

  constructor(scope: SettingsScope<AutoProxySettings>) {
    this.scope = scope
    this.store = createSnapshotStore(this.project())
  }

  /** Start the first load. Returns the disposer. */
  start(): () => void {
    const offScope = this.scope.subscribe(() => this.publish())
    void this.refreshStatus()
    return () => {
      this.disposed = true
      offScope()
    }
  }

  private current(): AutoProxySettings {
    return this.scope.getSnapshot().value ?? EMPTY
  }

  private fieldText(field: string, fallback: string): string {
    const staged = this.staged.get(field)
    return staged === undefined ? fallback : String(staged)
  }

  private project(): CardSnapshot {
    const snapshot = this.scope.getSnapshot()
    const value = this.current()
    return {
      available: snapshot.status === 'ready',
      writable: snapshot.writable,
      saving: this.saving,
      failed: this.failed,
      dirty: this.staged.size > 0,
      mode: (this.staged.has('mode') ? this.staged.get('mode') : value.mode) as 'off' | 'auto' | 'manual',
      http: this.fieldText('http', value.http),
      https: this.fieldText('https', value.https),
      socks: this.fieldText('socks', value.socks),
      noProxy: this.fieldText('noProxy', value.noProxy),
      gitApply: (this.staged.has('gitApply') ? this.staged.get('gitApply') : value.gitApply) as boolean,
      loadError: snapshot.status === 'unavailable' ? 'settings namespace not served by the host' : null,
      status: this.status,
      statusError: this.statusError,
      testing: this.testing,
      test: this.testResult,
      testError: this.testError,
    }
  }

  private publish(): void {
    if (this.disposed) return
    this.store.set(this.project())
  }

  private setField(field: string, value: string | boolean): void {
    this.staged.set(field, value)
    this.publish()
  }

  private async save(): Promise<void> {
    if (this.saving || !this.scope.getSnapshot().writable || this.staged.size === 0) return
    this.saving = true
    this.failed = false
    this.publish()
    const entries = [...this.staged.entries()]
    this.staged.clear()
    try {
      for (const [field, value] of entries) {
        if (typeof value === 'string' && value.trim() === '') await this.scope.unset(field)
        else await this.scope.set(field, value)
      }
      // The host is the only authority on what was accepted: an override is a
      // key present in the user layer, so a write that did not land leaves the
      // field absent (or with its previous value) and keeps the draft staged.
      const user = this.scope.getSnapshot().user as Record<string, unknown> | undefined
      for (const [field, value] of entries) {
        const wanted = typeof value === 'string' && value.trim() === '' ? undefined : value
        const present = user !== undefined && field in user
        const landed = wanted === undefined ? !present : present && user![field] === wanted
        if (!landed) {
          this.failed = true
          this.staged.set(field, value)
        }
      }
    } catch (error) {
      this.failed = true
      for (const [field, value] of entries) this.staged.set(field, value)
    } finally {
      this.saving = false
      this.publish()
      void this.refreshStatus()
    }
  }

  private discard(): void {
    this.staged.clear()
    this.publish()
  }

  private async refreshStatus(): Promise<void> {
    try {
      const response = await fetch('/api/dsh-auto-proxy/status')
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      this.status = (await response.json()) as ProxyStatusView
      this.statusError = null
    } catch (error) {
      this.status = null
      this.statusError = error instanceof Error ? error.message : String(error)
    }
    this.publish()
  }

  private async test(): Promise<void> {
    if (this.testing) return
    this.testing = true
    this.testResult = null
    this.testError = null
    this.publish()
    try {
      const response = await fetch('/api/dsh-auto-proxy/test', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      this.testResult = (await response.json()) as ProbeView
    } catch (error) {
      this.testResult = null
      this.testError = error instanceof Error ? error.message : String(error)
    } finally {
      this.testing = false
      this.publish()
    }
  }

  /** Build the face the card's slot registration injects. */
  inject(): AutoProxyCardFace {
    return {
      hooks: { autoProxyCard: this.store },
      actions: {
        setField: (field, value) => this.setField(field, value),
        save: () => void this.save(),
        discard: () => this.discard(),
        refreshStatus: () => void this.refreshStatus(),
        test: () => void this.test(),
      },
    }
  }
}
