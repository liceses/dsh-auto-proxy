/**
 * dsh-auto-proxy — browser half.
 *
 * Registers the auto-proxy configuration card into the
 * `settings.plugin.item` slot, which the settings surface renders under
 * Settings > Plugins > 插件配置. The card follows the official plugin-card
 * chrome (collapsible header, chevron, footer save/discard) and talks to the
 * host's own /api/dsh-auto-proxy routes (third-party settings namespaces are
 * not exposed through the official settingsScope transport).
 */

import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import { AutoProxyCardController } from './controller.ts'
import { AutoProxyCard } from './card.tsx'
import { CARD_CSS } from './styles.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    /** Plugin configuration cards under Settings > Plugins (owned by ui-settings-plugins). */
    'settings.plugin.item': { kind: 'list'; scope: 'root'; owner: Record<string, never> }
  }
}

/** Required services (fiber inject waiting — the slots runtime must be up). */
export const inject = ['slots']

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

  const controller = new AutoProxyCardController()
  ctx.effect(() => controller.start(), 'auto-proxy: card lifecycle')

  ctx.slots.inject('settings.plugin.item', () => ctx.slots.register({
    name: 'settings.plugin.item',
    id: 'auto-proxy',
    order: 30,
    inject: () => controller.inject(),
  }, AutoProxyCard))
}
