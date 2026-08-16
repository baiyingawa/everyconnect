import { homedir } from 'node:os'
import { join } from 'node:path'
import { bindPollingLifecycle, bindWechatDshSessionRouter, bindWechatQrRoutes, createConnectionStatusTool, injectWebServices, registerRawTool, WechatDshSessionRouter } from './dsh/index.js'
import type { EffectContext, LazyInjectContext, PollingService, ToolRegistryContext } from './dsh/index.js'
import type { PlatformAdapter } from './platform/types.js'
import { FileSessionStore, FileSettingsStore } from './session/store.js'
import { WechatApiClient } from './wechat/client.js'
import { WechatClawAdapter } from './wechat/adapter.js'
import { WechatQrLoginService } from './wechat/qr-login.js'

export const name = 'everyconnect'
export const inject = ['tools']

export interface EveryConnectPluginContext extends EffectContext, LazyInjectContext, ToolRegistryContext {}

export interface EveryConnectPluginConfig {
  poller?: PollingService
  adapter?: PlatformAdapter
  baseUrl?: string
  sessionStorePath?: string
  settingsStorePath?: string
  webEnabled?: boolean
  getStatus?: () => unknown
}

export function apply(ctx: EveryConnectPluginContext, config: EveryConnectPluginConfig = {}) {
  let router: WechatDshSessionRouter | undefined
  let activeAdapter: PlatformAdapter | undefined
  const fetcher = (input: string, init: RequestInit) => fetch(input, init)
  const sessionStore = new FileSessionStore(config.sessionStorePath || join(homedir(), '.dsh', 'everyconnect', 'session.json'))
  const settingsStore = new FileSettingsStore(config.settingsStorePath || join(homedir(), '.dsh', 'everyconnect', 'settings.json'))
  const adapter = config.adapter || new WechatClawAdapter({
    client: new WechatApiClient({
      fetcher,
      baseUrl: config.baseUrl,
    }),
    sessionStore,
    onMessage: async (message, signal) => {
      if (router) {
        await router.handle(message, signal)
        return
      }
      await activeAdapter?.send({ platform: 'wechat-claw', conversationId: message.senderId, text: 'DSH 会话服务尚未就绪，请稍后重试。', replyContext: message.replyContext }, signal)
    },
  })
  activeAdapter = adapter
  bindPollingLifecycle(ctx, config.poller || adapter)
  registerRawTool(ctx, createConnectionStatusTool(config.getStatus || (() => ({ enabled: true, platform: 'wechat-claw' }))))
  bindWechatQrRoutes(ctx, new WechatQrLoginService({ fetcher, sessionStore }))
  bindWechatDshSessionRouter(ctx, adapter, settingsStore, (next) => { router = next })
  if (config.webEnabled) injectWebServices(ctx, () => undefined)
}
