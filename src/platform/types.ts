export type PlatformId = 'wechat-claw'

export interface InboundAttachment {
  kind: 'audio' | 'file'
  fileName: string
  mimeType: string
  size?: number
  durationMs?: number
  transcript?: string
  localPath?: string
  remote?: {
    fullUrl?: string
    encryptQueryParam?: string
    aesKey?: string
  }
}

export interface InboundMessage {
  platform: PlatformId
  accountId: string
  conversationId: string
  senderId: string
  messageId: string
  text: string
  attachments?: InboundAttachment[]
  receivedAt: number
  replyContext?: {
    contextToken: string
  }
  rawType: 'text' | 'audio' | 'file'
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
