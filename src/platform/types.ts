export type PlatformId = 'wechat-claw'

export interface InboundMessage {
  platform: PlatformId
  accountId: string
  conversationId: string
  senderId: string
  messageId: string
  text: string
  receivedAt: number
  replyContext?: {
    contextToken: string
  }
  rawType: 'text'
}

export interface OutboundMessage {
  platform: PlatformId
  conversationId: string
  text: string
  replyContext?: {
    contextToken: string
  }
}

export interface PlatformAdapter {
  readonly platform: PlatformId
  start(signal: AbortSignal): Promise<void>
  send(message: OutboundMessage, signal: AbortSignal): Promise<void>
  setTyping?(conversationId: string, contextToken: string | undefined, typing: boolean, signal: AbortSignal): Promise<void>
  stop(): Promise<void>
}
