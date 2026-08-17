/**
 * Build config for the dsh-mcp-manage plugin.
 *
 * Uses the vendored dsh client-bundle preset (shared/tsdown.client.ts): the
 * node-half lib/ plus the browser bundle lib/client.js (closure-factory
 * artifact for the GUI's __ModuleLoader__).
 */
import { clientBundle } from './shared/tsdown.client.ts'

export default clientBundle('dsh-mcp-manage', ['src/index.ts'], {
  libExternal: [
    '@deepseek-ai/dsh-client-runtime',
    '@deepseek-ai/dsh-client-ui-settings',
    '@deepseek-ai/dsh-client-ui-slots',
    '@deepseek-ai/dsh-host-webserver',
  ],
})
