import type { InboundAttachment, InboundMessage } from '../platform/types.js'

export const DEFAULT_BASE_URL = 'https://ilinkai.weixin.qq.com'
export const DEFAULT_CDN_BASE_URL = 'https://novac2c.cdn.weixin.qq.com/c2c'
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

interface CDNMedia {
  full_url?: string
  encrypt_query_param?: string
  aes_key?: string
}

export type TypingStatus = 1 | 2

export interface GetTypingTicketInput {
  ilinkUserId: string
  contextToken: string
  channelVersion?: string
}

export interface SendTypingInput {
  ilinkUserId: string
  typingTicket: string
  status: TypingStatus
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
  const attachments = items.flatMap(parseInboundAttachment)
  const transcript = attachments.map((attachment) => attachment.transcript || '').filter(Boolean).join('\n')
  const messageText = [text, transcript].filter(Boolean).join('\n')
  if (!messageText && attachments.length === 0) return null

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
    text: messageText || attachments.map(formatAttachmentText).join('\n'),
    ...(attachments.length ? { attachments } : {}),
    receivedAt,
    ...(contextToken ? { replyContext: { contextToken } } : {}),
    rawType: attachments[0]?.kind || 'text',
  }
}

function parseInboundAttachment(item: unknown): InboundAttachment[] {
  if (!isRecord(item)) return []
  const type = numberField(item, 'type')
  if (type === 3) {
    const voice = asOptionalRecord(item.voice_item) || {}
    const media = parseMedia(voice?.media)
    if (!media) return []
    return [{
      kind: 'audio',
      fileName: voiceFileName(numberField(voice, 'encode_type')),
      mimeType: voiceMimeType(numberField(voice, 'encode_type')),
      ...(numberField(voice, 'playtime') ? { durationMs: numberField(voice, 'playtime') } : {}),
      ...(stringField(voice, 'text') ? { transcript: stringField(voice, 'text') } : {}),
      remote: media,
    }]
  }
  if (type === 4) {
    const file = asOptionalRecord(item.file_item) || {}
    const media = parseMedia(file?.media)
    if (!media) return []
    return [{
      kind: 'file',
      fileName: safeFileName(stringField(file, 'file_name') || 'wechat-file'),
      mimeType: mimeTypeFromName(stringField(file, 'file_name')),
      ...(sizeField(file, 'len') ? { size: sizeField(file, 'len') } : {}),
      remote: media,
    }]
  }
  return []
}

function parseMedia(input: unknown): InboundAttachment['remote'] | undefined {
  const media = asOptionalRecord(input) as CDNMedia | undefined
  if (!media) return undefined
  const fullUrl = typeof media.full_url === 'string' ? media.full_url : undefined
  const encryptQueryParam = typeof media.encrypt_query_param === 'string' ? media.encrypt_query_param : undefined
  const aesKey = typeof media.aes_key === 'string' ? media.aes_key : undefined
  if (!fullUrl && !encryptQueryParam) return undefined
  return { ...(fullUrl ? { fullUrl } : {}), ...(encryptQueryParam ? { encryptQueryParam } : {}), ...(aesKey ? { aesKey } : {}) }
}

function formatAttachmentText(attachment: InboundAttachment): string {
  return attachment.kind === 'audio' ? `[微信语音：${attachment.fileName}]` : `[微信文件：${attachment.fileName}]`
}

function voiceMimeType(encodeType: number | undefined): string {
  if (encodeType === 7) return 'audio/mpeg'
  if (encodeType === 8) return 'audio/ogg'
  return 'audio/silk'
}

function voiceFileName(encodeType: number | undefined): string {
  if (encodeType === 7) return 'wechat-audio.mp3'
  if (encodeType === 8) return 'wechat-audio.ogg'
  return 'wechat-audio.silk'
}

function mimeTypeFromName(fileName: string): string {
  const extension = fileName.toLowerCase().split('.').at(-1)
  const types: Record<string, string> = {
    txt: 'text/plain', json: 'application/json', pdf: 'application/pdf',
    doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    zip: 'application/zip', csv: 'text/csv', md: 'text/markdown',
  }
  return (extension && types[extension]) || 'application/octet-stream'
}

function safeFileName(fileName: string): string {
  const normalized = fileName.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').trim()
  return normalized || 'wechat-file'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asOptionalRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined
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

export function buildGetTypingTicketPayload(input: GetTypingTicketInput) {
  if (!input.ilinkUserId.trim()) throw new Error('ilinkUserId must not be empty')
  if (!input.contextToken.trim()) throw new Error('contextToken must not be empty')
  return {
    ilink_user_id: input.ilinkUserId,
    context_token: input.contextToken,
    base_info: buildBaseInfo(input.channelVersion),
  }
}

export function parseTypingTicket(input: unknown): string {
  const ticket = stringField(asRecord(input), 'typing_ticket')
  if (!ticket) throw new Error('typing ticket is missing')
  return ticket
}

export function buildSendTypingPayload(input: SendTypingInput) {
  if (!input.ilinkUserId.trim()) throw new Error('ilinkUserId must not be empty')
  if (!input.typingTicket.trim()) throw new Error('typingTicket must not be empty')
  if (input.status !== 1 && input.status !== 2) throw new Error('typing status must be 1 or 2')
  return {
    ilink_user_id: input.ilinkUserId,
    typing_ticket: input.typingTicket,
    status: input.status,
    base_info: buildBaseInfo(input.channelVersion),
  }
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

function sizeField(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key]
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value)
  return undefined
}
