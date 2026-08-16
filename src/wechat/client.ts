import { randomUUID } from 'node:crypto'
import { createDecipheriv } from 'node:crypto'
import { buildBaseInfo, buildGetTypingTicketPayload, buildGetUpdatesPayload, buildHeaders, buildSendTextMessagePayload, buildSendTypingPayload, DEFAULT_BASE_URL, DEFAULT_CDN_BASE_URL, DEFAULT_CHANNEL_VERSION, parseQRCodePayload, parseQRCodeState, parseTypingTicket, type TypingStatus } from './protocol.js'
import type { InboundAttachment } from '../platform/types.js'
import { requestJson, type Fetcher } from './transport.js'

export interface WechatClientOptions {
  fetcher: Fetcher
  baseUrl?: string
  cdnBaseUrl?: string
  channelVersion?: string
  uinFactory?: () => string
}

export interface GetUpdatesResult {
  errcode?: number
  getUpdatesBuf: string
  longPollingTimeoutMs?: number
  messages: unknown[]
}

export class WechatApiClient {
  private baseUrl: string
  private readonly channelVersion: string
  private readonly cdnBaseUrl: string
  private readonly uinFactory: () => string
  private botToken = ''

  constructor(private readonly options: WechatClientOptions) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl || DEFAULT_BASE_URL)
    this.cdnBaseUrl = normalizeBaseUrl(options.cdnBaseUrl || DEFAULT_CDN_BASE_URL)
    this.channelVersion = options.channelVersion || DEFAULT_CHANNEL_VERSION
    this.uinFactory = options.uinFactory || (() => Buffer.from(String(Math.floor(Math.random() * 2 ** 32))).toString('base64'))
  }

  setBotToken(botToken: string): void {
    this.botToken = botToken
  }

  setBaseUrl(baseUrl: string): void {
    this.baseUrl = normalizeBaseUrl(baseUrl)
  }

  async getQRCode(signal: AbortSignal) {
    const body = await requestJson(this.options.fetcher, `${this.baseUrl}/ilink/bot/get_bot_qrcode?bot_type=3`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ local_token_list: [] }),
    }, signal)
    return parseQRCodePayload(body)
  }

  async pollQRCodeStatus(qrcode: string, verifyCode: string, signal: AbortSignal) {
    const params = new URLSearchParams({ qrcode })
    if (verifyCode) params.set('verify_code', verifyCode)
    const body = await requestJson(this.options.fetcher, `${this.baseUrl}/ilink/bot/get_qrcode_status?${params}`, {
      method: 'GET',
      headers: { 'Accept': 'application/json' },
    }, signal)
    return parseQRCodeState(body)
  }

  async getUpdates(cursor: string, signal: AbortSignal): Promise<GetUpdatesResult> {
    const body = await requestJson(this.options.fetcher, `${this.baseUrl}/ilink/bot/getupdates`, {
      method: 'POST',
      headers: this.authHeaders(),
      body: JSON.stringify(buildGetUpdatesPayload(cursor, this.channelVersion)),
    }, signal)
    const record = asRecord(body)
    return {
      errcode: numberField(record, 'errcode'),
      getUpdatesBuf: stringField(record, 'get_updates_buf') || cursor,
      longPollingTimeoutMs: numberField(record, 'longpolling_timeout_ms'),
      messages: Array.isArray(record.msgs) ? record.msgs : [],
    }
  }

  async sendTextMessage(toUserId: string, contextToken: string, text: string, signal: AbortSignal): Promise<void> {
    const payload = buildSendTextMessagePayload({
      toUserId,
      clientId: randomUUID().replaceAll('-', ''),
      contextToken,
      text,
      channelVersion: this.channelVersion,
    })
    await requestJson(this.options.fetcher, `${this.baseUrl}/ilink/bot/sendmessage`, {
      method: 'POST',
      headers: this.authHeaders(),
      body: JSON.stringify(payload),
    }, signal)
  }

  async downloadMedia(attachment: InboundAttachment, signal: AbortSignal): Promise<Uint8Array> {
    const remote = attachment.remote
    if (!remote) throw new Error('WeChat media reference is missing')
    signal.throwIfAborted()
    const url = remote.fullUrl || (remote.encryptQueryParam
      ? `${this.cdnBaseUrl}/download?encrypted_query_param=${encodeURIComponent(remote.encryptQueryParam)}`
      : '')
    if (!url) throw new Error('WeChat media download URL is missing')
    const response = await this.options.fetcher(url, { method: 'GET', headers: { Accept: '*/*' }, signal })
    if (!response.ok) throw new Error(`WeChat media download failed with HTTP ${response.status}`)
    const encrypted = new Uint8Array(await response.arrayBuffer())
    return decryptMedia(encrypted, remote.aesKey)
  }

  async getTypingTicket(ilinkUserId: string, contextToken: string, signal: AbortSignal): Promise<string> {
    const body = await requestJson(this.options.fetcher, `${this.baseUrl}/ilink/bot/getconfig`, {
      method: 'POST',
      headers: this.authHeaders(),
      body: JSON.stringify(buildGetTypingTicketPayload({ ilinkUserId, contextToken, channelVersion: this.channelVersion })),
    }, signal)
    return parseTypingTicket(body)
  }

  async sendTyping(ilinkUserId: string, typingTicket: string, status: TypingStatus, signal: AbortSignal): Promise<void> {
    await requestJson(this.options.fetcher, `${this.baseUrl}/ilink/bot/sendtyping`, {
      method: 'POST',
      headers: this.authHeaders(),
      body: JSON.stringify(buildSendTypingPayload({ ilinkUserId, typingTicket, status, channelVersion: this.channelVersion })),
    }, signal)
  }

  private authHeaders(): Record<string, string> {
    return buildHeaders(this.botToken, this.uinFactory())
  }
}

function decryptMedia(input: Uint8Array, encodedKey: string | undefined): Uint8Array {
  if (!encodedKey) return input
  const key = decodeAesKey(encodedKey)
  const decipher = createDecipheriv('aes-128-ecb', key, null)
  decipher.setAutoPadding(true)
  return new Uint8Array(Buffer.concat([decipher.update(input), decipher.final()]))
}

function decodeAesKey(encodedKey: string): Buffer {
  const decoded = Buffer.from(encodedKey, 'base64')
  if (decoded.length === 16) return decoded
  const decodedText = decoded.toString('utf8').trim()
  if (/^[0-9a-f]{32}$/i.test(decodedText)) return Buffer.from(decodedText, 'hex')
  if (/^[0-9a-f]{32}$/i.test(encodedKey)) return Buffer.from(encodedKey, 'hex')
  throw new Error('WeChat media AES key is invalid')
}

function normalizeBaseUrl(baseUrl: string): string {
  return (baseUrl || DEFAULT_BASE_URL).replace(/\/$/, '')
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('expected an object')
  return value as Record<string, unknown>
}

function stringField(record: Record<string, unknown>, key: string): string {
  return typeof record[key] === 'string' ? record[key] : ''
}

function numberField(record: Record<string, unknown>, key: string): number | undefined {
  return typeof record[key] === 'number' ? record[key] : undefined
}
