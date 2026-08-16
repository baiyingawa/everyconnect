import { randomUUID } from 'node:crypto'
import { buildBaseInfo, buildGetUpdatesPayload, buildHeaders, buildSendTextMessagePayload, DEFAULT_BASE_URL, DEFAULT_CHANNEL_VERSION, parseQRCodePayload, parseQRCodeState } from './protocol.js'
import { requestJson, type Fetcher } from './transport.js'

export interface WechatClientOptions {
  fetcher: Fetcher
  baseUrl?: string
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
  private readonly baseUrl: string
  private readonly channelVersion: string
  private readonly uinFactory: () => string
  private botToken = ''

  constructor(private readonly options: WechatClientOptions) {
    this.baseUrl = (options.baseUrl || DEFAULT_BASE_URL).replace(/\/$/, '')
    this.channelVersion = options.channelVersion || DEFAULT_CHANNEL_VERSION
    this.uinFactory = options.uinFactory || (() => Buffer.from(String(Math.floor(Math.random() * 2 ** 32))).toString('base64'))
  }

  setBotToken(botToken: string): void {
    this.botToken = botToken
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

  private authHeaders(): Record<string, string> {
    return buildHeaders(this.botToken, this.uinFactory())
  }
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
