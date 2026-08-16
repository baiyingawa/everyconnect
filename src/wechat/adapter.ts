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
  private readonly seenMessageIds = new Set<string>()
  private readonly typingTickets = new Map<string, string>()

  constructor(private readonly options: WechatAdapterOptions) {}

  async start(signal: AbortSignal): Promise<void> {
    this.session = null
    this.stopped = false

    while (!signal.aborted && !this.stopped) {
      if (!this.session) this.session = await this.options.sessionStore.load(signal)
      if (!this.session?.auth.botToken || this.session.metadata.sessionExpired) {
        this.session = null
        await wait(this.options.retryDelayMs ?? 3000, signal)
        continue
      }
      this.seenMessageIds.clear()
      for (const messageId of this.session.metadata.recentMessageIds || []) this.seenMessageIds.add(messageId)
      this.options.client.setBaseUrl(this.session.auth.baseUrl)
      this.options.client.setBotToken(this.session.auth.botToken)
      try {
        const previousCursor = this.session.cursor.getUpdatesBuf
        const previousTimeout = this.session.cursor.longPollingTimeoutMs
        const result = await this.options.client.getUpdates(this.session.cursor.getUpdatesBuf, signal)
        if (result.errcode === -14) {
          this.session.metadata.sessionExpired = true
          await this.options.sessionStore.save(this.session, signal)
          this.session = null
          continue
        }

        for (const rawMessage of result.messages) {
          const message = parseInboundMessage(rawMessage, this.options.now?.() ?? Date.now())
          if (!message) continue
          if (this.seenMessageIds.has(message.messageId)) continue
          if (message.replyContext) this.session.contextTokens[message.senderId] = message.replyContext.contextToken
          await this.options.onMessage(message, signal)
          this.rememberMessageId(message.messageId)
        }

        this.session.cursor.getUpdatesBuf = result.getUpdatesBuf
        if (result.longPollingTimeoutMs) this.session.cursor.longPollingTimeoutMs = result.longPollingTimeoutMs
        this.session.metadata.lastActiveAt = this.options.now?.() ?? Date.now()
        if (result.messages.length > 0 || result.getUpdatesBuf !== previousCursor || result.longPollingTimeoutMs !== previousTimeout) {
          await this.options.sessionStore.save(this.session, signal)
        }
      } catch (error) {
        if (signal.aborted || this.stopped) return
        if (error instanceof WechatApiError && error.kind === 'retryable') {
          await wait(this.options.retryDelayMs ?? 3000, signal)
          continue
        }
        console.error('[everyconnect] WeChat polling error:', error)
        await wait(this.options.retryDelayMs ?? 3000, signal)
      }
    }
  }

  async send(message: OutboundMessage, signal: AbortSignal): Promise<void> {
    if (!this.session) throw new WechatApiError('WeChat adapter is not started', 'fatal')
    const contextToken = message.replyContext?.contextToken || this.session.contextTokens[message.conversationId]
    if (!contextToken) throw new WechatApiError('Missing WeChat context token', 'invalid-payload')
    await this.options.client.sendTextMessage(message.conversationId, contextToken, message.text, signal)
  }

  async setTyping(conversationId: string, contextToken: string | undefined, typing: boolean, signal: AbortSignal): Promise<void> {
    if (!this.session) return
    const activeContextToken = contextToken || this.session.contextTokens[conversationId]
    if (!activeContextToken) return
    const ticketKey = `${conversationId}:${activeContextToken}`
    let ticket = this.typingTickets.get(ticketKey)
    if (!ticket) {
      ticket = await this.options.client.getTypingTicket(this.session.auth.ilinkUserId, activeContextToken, signal)
      this.typingTickets.set(ticketKey, ticket)
    }
    await this.options.client.sendTyping(conversationId, ticket, typing ? 1 : 2, signal)
  }

  async stop(): Promise<void> {
    this.stopped = true
    this.typingTickets.clear()
  }

  private rememberMessageId(messageId: string): void {
    if (!this.session) return
    this.seenMessageIds.add(messageId)
    while (this.seenMessageIds.size > 200) {
      const oldest = this.seenMessageIds.values().next().value
      if (typeof oldest !== 'string') break
      this.seenMessageIds.delete(oldest)
    }
    this.session.metadata.recentMessageIds = [...this.seenMessageIds]
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
