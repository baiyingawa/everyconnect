import { bindPollingLifecycle, createConnectionStatusTool, injectWebServices, registerRawTool } from './dsh/index.js'
import type { EffectContext, LazyInjectContext, PollingService, ToolRegistryContext } from './dsh/index.js'

export const name = 'everyconnect'
export const inject = ['tools']

export interface EveryConnectPluginContext extends EffectContext, LazyInjectContext, ToolRegistryContext {}

export interface EveryConnectPluginConfig {
  poller?: PollingService
  webEnabled?: boolean
  getStatus?: () => unknown
}

/** Host entry point. The concrete WeChat adapter is supplied by the profile wiring. */
export function apply(ctx: EveryConnectPluginContext, config: EveryConnectPluginConfig = {}) {
  if (config.poller) bindPollingLifecycle(ctx, config.poller)
  registerRawTool(ctx, createConnectionStatusTool(config.getStatus || (() => ({ enabled: Boolean(config.poller) }))))
  if (config.webEnabled) injectWebServices(ctx, () => undefined)
}
