/**
 * dsh-auto-proxy — browser half controller.
 *
 * The web client cannot bind third-party settings namespaces through the
 * official `settingsScope` transport: dsh-host-apiproxy only exposes a
 * hard-coded whitelist of namespaces (`settings-not-exposed` otherwise, which
 * surfaces as an unavailable read-only scope and disables every control).
 * This controller therefore talks to the host's own /api/dsh-auto-proxy
 * routes instead — the host writes through the settings service directly
 * (schema validation, revision fencing and file persistence included).
 * All state mirrors into one snapshot store the card renders through.
 */

import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
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
}

interface SettingsView {
  value?: AutoProxySettings
  writable?: boolean
  error?: string
}

/** Bridge the host settings route onto the card's snapshot store. */
export class AutoProxyCardController {
  private readonly store: SnapshotStore<CardSnapshot>
  private readonly staged = new Map<string, string | boolean>()
  private value: AutoProxySettings | null = null
  private writable = false
  private available = false
  private loadError: string | null = null
  private status: ProxyStatusView | null = null
  private statusError: string | null = null
  private testing = false
  private testResult: ProbeView | null = null
  private testError: string | null = null
  private saving = false
  private failed = false
  private disposed = false

  constructor() {
    this.store = createSnapshotStore(this.project())
  }

  /** Start the first load. Returns the disposer. */
  start(): () => void {
    void this.refreshAll()
    return () => {
      this.disposed = true
    }
  }

  private current(): AutoProxySettings {
    return this.value ?? EMPTY
  }

  private fieldText(field: string, fallback: string): string {
    const staged = this.staged.get(field)
    return staged === undefined ? fallback : String(staged)
  }

  private project(): CardSnapshot {
    const value = this.current()
    return {
      available: this.available,
      writable: this.writable,
      saving: this.saving,
      failed: this.failed,
      dirty: this.staged.size > 0,
      mode: (this.staged.has('mode') ? this.staged.get('mode') : value.mode) as 'off' | 'auto' | 'manual',
      http: this.fieldText('http', value.http),
      https: this.fieldText('https', value.https),
      socks: this.fieldText('socks', value.socks),
      noProxy: this.fieldText('noProxy', value.noProxy),
      gitApply: (this.staged.has('gitApply') ? this.staged.get('gitApply') : value.gitApply) as boolean,
      loadError: this.loadError,
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

  private async loadSettings(): Promise<void> {
    try {
      const response = await fetch('/api/dsh-auto-proxy/settings')
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const view = (await response.json()) as SettingsView
      if (view.error !== undefined) throw new Error(view.error)
      this.value = view.value ?? EMPTY
      this.writable = view.writable === true
      this.available = true
      this.loadError = null
    } catch (error) {
      this.available = false
      this.writable = false
      this.loadError = error instanceof Error ? error.message : String(error)
    }
    this.publish()
  }

  private async save(): Promise<void> {
    if (this.saving || !this.writable || this.staged.size === 0) return
    this.saving = true
    this.failed = false
    this.publish()
    const set: Record<string, string | boolean> = {}
    const unset: string[] = []
    for (const [field, value] of this.staged) {
      if (typeof value === 'string' && value.trim() === '') unset.push(field)
      else set[field] = value
    }
    try {
      const response = await fetch('/api/dsh-auto-proxy/settings', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ set, unset }),
      })
      const view = (await response.json()) as SettingsView
      if (!response.ok || view.error !== undefined) throw new Error(view.error ?? `HTTP ${response.status}`)
      this.value = view.value ?? this.value
      this.writable = view.writable === true
      this.staged.clear()
    } catch (error) {
      this.failed = true
      this.loadError = error instanceof Error ? error.message : String(error)
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

  private async refreshAll(): Promise<void> {
    await Promise.all([this.loadSettings(), this.refreshStatus()])
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
