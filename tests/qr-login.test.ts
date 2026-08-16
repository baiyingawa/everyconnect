import { WechatQrLoginService } from '../src/wechat/qr-login.js'
import type { EveryConnectSession, SessionStore } from '../src/session/store.js'
import type { Fetcher } from '../src/wechat/transport.js'

describe('WechatQrLoginService', () => {
  it('gets a QR code, polls confirmation, and persists the session', async () => {
    const saved: EveryConnectSession[] = []
    const store: SessionStore = {
      load: async () => null,
      save: async (session) => { saved.push(session) },
      clear: async () => undefined,
    }
    let call = 0
    const fetcher: Fetcher = async (_url, _init) => {
      call += 1
      if (call === 1) return new Response(JSON.stringify({ qrcode_img_content: 'https://qr.test/image', qrcode: 'qr-token' }), { status: 200 })
      return new Response(JSON.stringify({
        status: 'confirmed',
        bot_token: 'bot-token',
        ilink_bot_id: 'bot-id',
        ilink_user_id: 'user-id',
        baseurl: 'https://ilinkai.weixin.qq.com',
      }), { status: 200 })
    }

    const service = new WechatQrLoginService({ fetcher, sessionStore: store, now: () => 100 })
    await service.start()
    await vi.waitFor(() => expect(service.getStatus()).toEqual({ state: 'confirmed' }))

    expect(saved).toHaveLength(1)
    expect(saved[0]).toMatchObject({
      auth: { botToken: 'bot-token', ilinkBotId: 'bot-id', ilinkUserId: 'user-id' },
      metadata: { createdAt: 100, lastActiveAt: 100, sessionExpired: false },
    })
    expect(call).toBe(2)
  })
})
