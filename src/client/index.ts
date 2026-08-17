/**
 * MCP management client plugin — registers the settings page
 * (设置 → MCP 管理) into `settings.section`. The page talks to the host
 * route family under /api/dsh-mcp-manage served by the node half.
 *
 * @module dsh-mcp-manage/client
 */

import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: pulls the settings-surface SlotMap merge (the 'settings.section'
// entry).
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import { CSS, McpManageSection } from './McpManageSection.tsx'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    'settings.section': {
      kind: 'list'
      scope: 'root'
      owner: { close: () => void }
    }
  }
}

/** Required services. */
export const inject = ['slots']

/**
 * Register the MCP-management settings page.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => {
    const style = document.createElement('style')
    style.dataset.plugin = 'dsh-mcp-manage'
    style.textContent = CSS
    document.head.appendChild(style)
    return () => style.remove()
  }, 'mcp-manage: styles')

  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'mcp-manage',
    order: 24,
    label: 'MCP 管理',
  }, McpManageSection))
}
