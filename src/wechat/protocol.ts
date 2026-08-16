import type { InboundMessage } from '../platform/types.js'

export const DEFAULT_BASE_URL = 'https://ilinkai.weixin.qq.com'
export const DEFAULT_CHANNEL_VERSION = '1.0.2'

export interface QRCodePayload {
  qrcodeImgContent: string
  qrcode: string
}

export type QRCodeState =
  | { kind: 'wait' }
  | { kind: 'scanned' }
  | { kind: 'confirmed'; botToken: string; ilinkBotId: string; ilinkUserId: string; baseUrl?: string }
  | { kind: 'expired' }
  | { kind: 'canceled' }
  | { kind: 'rejected' }
  | { kind: 'unknown'; rawStatus: string }

export interface SendTextMessageInput {
  toUserId: string
  clientId: string
  contextToken: string
  text: string
  channelVersion?: string
}

export function buildHeaders(botToken: string, uin: string): Record<string, string> {
  if (!botToken.trim()) throw new Error('botToken must not be empty')
  if (!uin.trim()) throw new Error('uin must not be empty')
  return {
    'Content-Type': 'application/json',
    AuthorizationType: 'ilink_bot_token',
    Authorization: `Bearer ${botToken}`,
    'X-WECHAT-UIN': uin,
  }
}

export function buildBaseInfo(channelVersion = DEFAULT_CHANNEL_VERSION): { channel_version: string } {
  if (!channelVersion.trim()) throw new Error('channelVersion must not be empty')
  return { channel_version: channelVersion }
}

export function parseQRCodePayload(input: unknown): QRCodePayload {
  const record = asRecord(input)
  const qrcodeImgContent = stringField(record, 'qrcode_img_content')
  const qrcode = stringField(record, 'qrcode')
  if (!qrcodeImgContent || !qrcode) throw new Error('QR response is missing qrcode fields')
  return { qrcodeImgContent, qrcode }
}

export function parseQRCodeState(input: unknown): QRCodeState {
  const record = asRecord(input)
  const status = stringField(record, 'status')
  switch (status) {
    case 'wait':
      return { kind: 'wait' }
    case 'scaned':
      return { kind: 'scanned' }
    case 'confirmed': {
      const botToken = stringField(record, 'bot_token')
      const ilinkBotId = stringField(record, 'ilink_bot_id')
      const ilinkUserId = stringField(record, 'ilink_user_id')
      if (!botToken || !ilinkBotId || !ilinkUserId) {
        throw new Error('confirmed QR response is missing session fields')
      }
      return {
        kind: 'confirmed',
        botToken,
        ilinkBotId,
        ilinkUserId,
        baseUrl: stringField(record, 'baseurl') || undefined,
      }
    }
    case 'expired':
      return { kind: 'expired' }
    case 'canceled':
      return { kind: 'canceled' }
    case 'rejected':
      return { kind: 'rejected' }
    default:
      return { kind: 'unknown', rawStatus: status }
  }
}

export function parseInboundMessage(input: unknown, receivedAt = Date.now()): InboundMessage | null {
  const message = asRecord(input)
  if (numberField(message, 'message_type') !== 1) return null

  const senderId = stringField(message, 'from_user_id')
  if (!senderId) return null

  const items = Array.isArray(message.item_list) ? message.item_list : []
  const text = items
    .filter((item): item is Record<string, unknown> => isRecord(item) && numberField(item, 'type') === 1)
    .map((item) => stringField(asRecord(item.text_item), 'text'))
    .filter(Boolean)
    .join('\n')
  if (!text) return null

  const contextToken = stringField(message, 'context_token')
  const messageId =
    stringField(message, 'message_id') ||
    stringField(message, 'msg_id') ||
    `${senderId}:${stringField(message, 'create_time_ms') || receivedAt}:${text}`

  return {
    platform: 'wechat-claw',
    accountId: stringField(message, 'to_user_id') || stringField(message, 'ilink_bot_id') || 'default',
    conversationId: stringField(message, 'conversation_id') || senderId,
    senderId,
    messageId,
    text,
    receivedAt,
    ...(contextToken ? { replyContext: { contextToken } } : {}),
    rawType: 'text',
  }
}

export function buildGetUpdatesPayload(cursor: string, channelVersion = DEFAULT_CHANNEL_VERSION) {
  return {
    get_updates_buf: cursor,
    base_info: buildBaseInfo(channelVersion),
  }
}

export function buildSendTextMessagePayload(input: SendTextMessageInput) {
  if (!input.toUserId.trim()) throw new Error('toUserId must not be empty')
  if (!input.clientId.trim()) throw new Error('clientId must not be empty')
  if (!input.contextToken.trim()) throw new Error('contextToken must not be empty')
  if (!input.text.trim()) throw new Error('text must not be empty')
  return {
    msg: {
      to_user_id: input.toUserId,
      client_id: input.clientId,
      message_type: 2,
      message_state: 2,
      context_token: input.contextToken,
      item_list: [{ type: 1, text_item: { text: input.text } }],
    },
    base_info: buildBaseInfo(input.channelVersion),
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error('expected an object')
  return value
}

function stringField(record: Record<string, unknown>, key: string): string {
  return typeof record[key] === 'string' ? record[key] : ''
}

function numberField(record: Record<string, unknown>, key: string): number | undefined {
  return typeof record[key] === 'number' ? record[key] : undefined
}
