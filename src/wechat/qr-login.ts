import { homedir } from 'node:os'
import { join } from 'node:path'
import { WechatApiClient } from './client.js'
import { WechatApiError } from './errors.js'
import { DEFAULT_BASE_URL, type QRCodeState } from './protocol.js'
import { createSession, FileSessionStore, type SessionStore } from '../session/store.js'

export type QrLoginStatus =
  | { state: 'idle' }
  | { state: 'requesting' }
  | { state: 'waiting_scan'; qrImageUrl: string }
  | { state: 'scanned'; qrImageUrl: string }
  | { state: 'confirmed' }
  | { state: 'expired' }
  | { state: 'canceled' }
  | { state: 'error'; message: string }

export interface QrLoginOptions {
  fetcher?: ConstructorParameters<typeof WechatApiClient>[0]['fetcher']
  sessionStore?: SessionStore
  now?: () => number
}

export class WechatQrLoginService {
  private status: QrLoginStatus = { state: 'idle' }
  private controller: AbortController | undefined
  private qrToken = ''
  private verifyCode = ''
  private client: WechatApiClient | undefined

  constructor(private readonly options: QrLoginOptions = {}) {}

  getStatus(): QrLoginStatus {
    return this.status
  }

  async getConnectionStatus(): Promise<{ enabled: boolean; connected: boolean; sessionExpired: boolean }> {
    const store = this.options.sessionStore || new FileSessionStore(join(homedir(), '.dsh', 'everyconnect', 'session.json'))
    const session = await store.load(new AbortController().signal)
    const enabled = Boolean(session?.auth.botToken && !session.metadata.sessionExpired)
    return {
      enabled,
      connected: enabled,
      sessionExpired: Boolean(session?.metadata.sessionExpired),
    }
  }

  async start(baseUrl = DEFAULT_BASE_URL): Promise<QrLoginStatus> {
    if (this.controller && !isTerminal(this.status)) return this.status

    this.controller?.abort()
    const controller = new AbortController()
    this.controller = controller
    this.status = { state: 'requesting' }
    this.client = new WechatApiClient({
      fetcher: this.options.fetcher || ((input, init) => fetch(input, init)),
      baseUrl,
    })

    try {
      const qr = await this.client.getQRCode(controller.signal)
      this.qrToken = qr.qrcode
      this.verifyCode = ''
      this.status = { state: 'waiting_scan', qrImageUrl: qr.qrcodeImgContent }
      void this.poll(controller.signal, qr.qrcodeImgContent)
    } catch (error) {
      if (!controller.signal.aborted) this.status = { state: 'error', message: messageOf(error) }
    }
    return this.status
  }

  cancel(): QrLoginStatus {
    this.controller?.abort()
    this.controller = undefined
    this.status = { state: 'canceled' }
    return this.status
  }

  dispose(): void {
    this.controller?.abort()
    this.controller = undefined
  }

  private async poll(signal: AbortSignal, qrImageUrl: string): Promise<void> {
    if (!this.client) return
    try {
      while (!signal.aborted) {
        const next = await this.client.pollQRCodeStatus(this.qrToken, this.verifyCode, signal)
        if (next.kind === 'scanned') {
          this.status = { state: 'scanned', qrImageUrl }
          continue
        }
        if (next.kind === 'wait') {
          this.status = { state: 'waiting_scan', qrImageUrl }
          continue
        }
        if (next.kind === 'confirmed') {
          await this.saveSession(next)
          this.status = { state: 'confirmed' }
          this.controller = undefined
          return
        }
        if (next.kind === 'expired' || next.kind === 'canceled' || next.kind === 'rejected') {
          this.status = { state: next.kind === 'expired' ? 'expired' : 'canceled' }
          this.controller = undefined
          return
        }
        this.status = { state: 'error', message: `Unknown QR status: ${next.rawStatus}` }
        this.controller = undefined
        return
      }
    } catch (error) {
      if (!signal.aborted) {
        this.status = { state: 'error', message: messageOf(error) }
        this.controller = undefined
      }
    }
  }

  private async saveSession(next: Extract<QRCodeState, { kind: 'confirmed' }>): Promise<void> {
    const store = this.options.sessionStore || new FileSessionStore(join(homedir(), '.dsh', 'everyconnect', 'session.json'))
    const current = await store.load(new AbortController().signal)
    const now = this.options.now?.() ?? Date.now()
    const session = current || createSession({
      botToken: next.botToken,
      ilinkBotId: next.ilinkBotId,
      ilinkUserId: next.ilinkUserId,
      baseUrl: next.baseUrl || DEFAULT_BASE_URL,
    }, now)
    session.auth = {
      botToken: next.botToken,
      ilinkBotId: next.ilinkBotId,
      ilinkUserId: next.ilinkUserId,
      baseUrl: next.baseUrl || DEFAULT_BASE_URL,
    }
    session.metadata.lastActiveAt = now
    session.metadata.sessionExpired = false
    await store.save(session, new AbortController().signal)
  }
}

function isTerminal(status: QrLoginStatus): boolean {
  return status.state === 'idle' || status.state === 'confirmed' || status.state === 'expired' || status.state === 'canceled' || status.state === 'error'
}

function messageOf(error: unknown): string {
  if (error instanceof WechatApiError) return error.message
  return error instanceof Error ? error.message : String(error)
}
