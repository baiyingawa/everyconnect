import { WechatApiError } from './errors.js'
import { WechatApiClient } from './client.js'
import { parseInboundMessage } from './protocol.js'
import type { InboundMessage, OutboundMessage, PlatformAdapter } from '../platform/types.js'
import type { EveryConnectSession, SessionStore } from '../session/store.js'

export interface WechatAdapterOptions {
  client: WechatApiClient
  sessionStore: SessionStore
  onMessage: (message: InboundMessage, signal: AbortSignal) => Promise<void>
  retryDelayMs?: number
  now?: () => number
}

export class WechatClawAdapter implements PlatformAdapter {
  readonly platform = 'wechat-claw' as const
  private session: EveryConnectSession | null = null
  private stopped = false

  constructor(private readonly options: WechatAdapterOptions) {}

  async start(signal: AbortSignal): Promise<void> {
    this.session = await this.options.sessionStore.load(signal)
    if (!this.session?.auth.botToken) throw new WechatApiError('WeChat login is required', 'fatal')
    this.options.client.setBotToken(this.session.auth.botToken)
    this.stopped = false

    while (!signal.aborted && !this.stopped) {
      try {
        const result = await this.options.client.getUpdates(this.session.cursor.getUpdatesBuf, signal)
        if (result.errcode === -14) {
          this.session.metadata.sessionExpired = true
          await this.options.sessionStore.save(this.session, signal)
          throw new WechatApiError('WeChat session expired', 'session-expired', undefined, -14)
        }

        for (const rawMessage of result.messages) {
          const message = parseInboundMessage(rawMessage, this.options.now?.() ?? Date.now())
          if (!message) continue
          if (message.replyContext) this.session.contextTokens[message.senderId] = message.replyContext.contextToken
          await this.options.onMessage(message, signal)
        }

        this.session.cursor.getUpdatesBuf = result.getUpdatesBuf
        if (result.longPollingTimeoutMs) this.session.cursor.longPollingTimeoutMs = result.longPollingTimeoutMs
        this.session.metadata.lastActiveAt = this.options.now?.() ?? Date.now()
        await this.options.sessionStore.save(this.session, signal)
      } catch (error) {
        if (signal.aborted || this.stopped) return
        if (error instanceof WechatApiError && error.kind === 'session-expired') throw error
        if (error instanceof WechatApiError && error.kind === 'retryable') {
          await wait(this.options.retryDelayMs ?? 3000, signal)
          continue
        }
        throw error
      }
    }
  }

  async send(message: OutboundMessage, signal: AbortSignal): Promise<void> {
    if (!this.session) throw new WechatApiError('WeChat adapter is not started', 'fatal')
    const contextToken = message.replyContext?.contextToken || this.session.contextTokens[message.conversationId]
    if (!contextToken) throw new WechatApiError('Missing WeChat context token', 'invalid-payload')
    await this.options.client.sendTextMessage(message.conversationId, contextToken, message.text, signal)
  }

  async stop(): Promise<void> {
    this.stopped = true
  }
}

function wait(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (milliseconds <= 0) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, milliseconds)
    const onAbort = () => {
      clearTimeout(timer)
      reject(signal.reason || new DOMException('The operation was aborted', 'AbortError'))
    }
    if (signal.aborted) onAbort()
    else signal.addEventListener('abort', onAbort, { once: true })
  })
}
