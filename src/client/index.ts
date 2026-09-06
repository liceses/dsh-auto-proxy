/**
 * dsh-auto-proxy — browser half.
 *
 * Registers the auto-proxy configuration card into the `settings.plugin.item`
 * slot under the `auto-proxy` settings namespace (Settings > Plugins >
 * 插件配置). rc7 keyed the card slot on the namespace it edits, so the card
 * binds its value through the official `ctx.settingsScope` transport; the
 * host serves every registered namespace, no whitelist involved. Live proxy
 * status and connectivity probes are runtime data, not settings, and stay on
 * the host's /api/dsh-auto-proxy/status + /test routes.
 */

// 0.1.2 split the client platform: `dsh-client-runtime` left the client module
// table (its snapshot-store face moved to `dsh-client-store`, the settings
// scope contract moved to `dsh-client-ui-settings/client`), so this entry
// declares the context face it consumes locally instead of importing the
// runtime's merged Context type. Type-only imports below are erased at build.
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings-plugins/client'
import type { SettingsScope } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { AutoProxySettings } from '../shared-types.ts'
import { AutoProxyCardController, type AutoProxyCardFace } from './controller.ts'
import { AutoProxyCard } from './card.tsx'
import { CARD_CSS } from './styles.ts'

/** Settings namespace this card edits (the keyed slot's dispatch key). */
const NS = 'auto-proxy'

/** The client-context face this plugin's browser half consumes. The shell
 * provides `slots` (ui-renderer's SlotRegistry service) and `effect`; the
 * settings domain provides `settingsScope` — both arrive as fiber services,
 * so a structural face is all the browser half needs. */
interface ClientContext {
  effect(fn: () => (() => void) | void, label?: string): void
  slots: {
    inject(key: string, callback: () => () => void): () => void
    register(spec: { name: string; key: string; inject: () => AutoProxyCardFace }, component: unknown): () => void
  }
  settingsScope: { bind<T>(spec: { namespace: string }): SettingsScope<T> }
}

/** Required services (fiber inject waiting — the slots runtime and the
 * settings-scope transport must be up; the binder needs connection + remote). */
export const inject = ['slots', 'connection', 'remote', 'settingsScope']

/**
 * Mount the card.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  // Package styles.
  ctx.effect(() => {
    const style = document.createElement('style')
    style.dataset.plugin = 'dsh-auto-proxy'
    style.textContent = CARD_CSS
    document.head.appendChild(style)
    return () => { style.remove() }
  }, 'auto-proxy: styles')

  const controller = new AutoProxyCardController(ctx.settingsScope.bind<AutoProxySettings>({ namespace: NS }))
  ctx.effect(() => controller.start(), 'auto-proxy: card lifecycle')

  ctx.slots.inject('settings.plugin.item', () => ctx.slots.register({
    name: 'settings.plugin.item',
    key: NS,
    inject: () => controller.inject(),
  }, AutoProxyCard))
}
