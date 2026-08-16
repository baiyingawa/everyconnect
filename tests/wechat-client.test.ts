import { WechatApiClient } from '../src/wechat/client.js'
import type { Fetcher } from '../src/wechat/transport.js'

describe('WechatApiClient fake transport', () => {
  it('injects fetch and propagates the AbortSignal to requests', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = []
    const fetcher: Fetcher = async (url, init) => {
      calls.push({ url, init })
      return new Response(JSON.stringify({ get_updates_buf: 'next', msgs: [], longpolling_timeout_ms: 35000 }), { status: 200 })
    }
    const client = new WechatApiClient({ fetcher, uinFactory: () => 'test-uin' })
    client.setBotToken('bot-token')
    const controller = new AbortController()

    const result = await client.getUpdates('current', controller.signal)

    expect(result).toEqual({ getUpdatesBuf: 'next', longPollingTimeoutMs: 35000, messages: [] })
    expect(calls).toHaveLength(1)
    expect(calls[0].init.signal).toBe(controller.signal)
    expect(calls[0].init.headers).toMatchObject({ Authorization: 'Bearer bot-token', 'X-WECHAT-UIN': 'test-uin' })
  })

  it('builds a sendmessage request through the same injected transport', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = []
    const fetcher: Fetcher = async (url, init) => {
      calls.push({ url, init })
      return new Response('{}', { status: 200 })
    }
    const client = new WechatApiClient({ fetcher, uinFactory: () => 'test-uin' })
    client.setBotToken('bot-token')

    await client.sendTextMessage('user-1', 'context-1', 'reply', new AbortController().signal)

    expect(calls[0].url).toContain('/ilink/bot/sendmessage')
    const body = JSON.parse(String(calls[0].init.body)) as { msg: { to_user_id: string; context_token: string; item_list: unknown[] } }
    expect(body.msg).toMatchObject({ to_user_id: 'user-1', context_token: 'context-1' })
    expect(body.msg.item_list).toHaveLength(1)
  })

  it('gets a typing ticket and sends start/stop typing requests', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = []
    const fetcher: Fetcher = async (url, init) => {
      calls.push({ url, init })
      return new Response(calls.length === 1 ? JSON.stringify({ typing_ticket: 'ticket-1' }) : '{}', { status: 200 })
    }
    const client = new WechatApiClient({ fetcher, uinFactory: () => 'test-uin' })
    client.setBotToken('bot-token')

    const signal = new AbortController().signal
    const ticket = await client.getTypingTicket('bot-user', 'context-1', signal)
    await client.sendTyping('wechat-user', ticket, 1, signal)
    await client.sendTyping('wechat-user', ticket, 2, signal)

    expect(ticket).toBe('ticket-1')
    expect(calls.map((call) => call.url)).toEqual([
      expect.stringContaining('/ilink/bot/getconfig'),
      expect.stringContaining('/ilink/bot/sendtyping'),
      expect.stringContaining('/ilink/bot/sendtyping'),
    ])
    expect(JSON.parse(String(calls[1].init.body))).toMatchObject({ status: 1, typing_ticket: 'ticket-1' })
    expect(JSON.parse(String(calls[2].init.body))).toMatchObject({ status: 2, typing_ticket: 'ticket-1' })
  })
})
