import { WechatClawAdapter } from '../src/wechat/adapter.js'
import type { WechatApiClient } from '../src/wechat/client.js'
import type { InboundMessage } from '../src/platform/types.js'
import type { EveryConnectSession, SessionStore } from '../src/session/store.js'

const session: EveryConnectSession = {
  auth: { botToken: 'bot', ilinkBotId: 'bot-id', ilinkUserId: 'user-id', baseUrl: 'https://example.test' },
  cursor: { getUpdatesBuf: 'old' },
  contextTokens: {},
  metadata: { createdAt: 1, lastActiveAt: 1, sessionExpired: false },
}

describe('WechatClawAdapter', () => {
  it('loads session, routes text, caches context, and persists the cursor', async () => {
    const saved: EveryConnectSession[] = []
    const store: SessionStore = {
      async load() { return structuredClone(session) },
      async save(value) { saved.push(structuredClone(value)) },
      async clear() {},
    }
    const getUpdates = vi.fn()
      .mockResolvedValueOnce({ getUpdatesBuf: 'next', messages: [{
        message_type: 1, message_id: 'm-1', from_user_id: 'user-1', context_token: 'ctx-1',
        item_list: [{ type: 1, text_item: { text: 'hello' } }],
      }, {
        message_type: 1, message_id: 'm-1', from_user_id: 'user-1', context_token: 'ctx-1',
        item_list: [{ type: 1, text_item: { text: 'hello' } }],
      }] })
      .mockImplementation(async (_cursor: string, signal: AbortSignal) => {
        await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }))
        return { getUpdatesBuf: 'next', messages: [] }
      })
    const client = {
      setBaseUrl: vi.fn(),
      setBotToken: vi.fn(),
      getUpdates,
      sendTextMessage: vi.fn(),
    } as unknown as WechatApiClient
    const received: InboundMessage[] = []
    const adapter = new WechatClawAdapter({ client, sessionStore: store, onMessage: async (message) => { received.push(message) }, retryDelayMs: 0, now: () => 10 })
    const controller = new AbortController()

    const running = adapter.start(controller.signal)
    await vi.waitFor(() => expect(received).toHaveLength(1))
    controller.abort()
    await running

    expect(client.setBotToken).toHaveBeenCalledWith('bot')
    expect(client.setBaseUrl).toHaveBeenCalledWith('https://example.test')
    expect(received).toHaveLength(1)
    expect(received[0].text).toBe('hello')
    expect(saved.at(-1)?.cursor.getUpdatesBuf).toBe('next')
    expect(saved.at(-1)?.contextTokens['user-1']).toBe('ctx-1')
  })

  it('keeps the host alive when the WeChat session expires and reloads after re-login', async () => {
    const saved: EveryConnectSession[] = []
    const store: SessionStore = {
      async load() { return structuredClone(session) },
      async save(value) { saved.push(structuredClone(value)) },
      async clear() {},
    }
    const getUpdates = vi.fn()
      .mockResolvedValueOnce({ errcode: -14, getUpdatesBuf: 'old', messages: [] })
      .mockImplementation(async (_cursor: string, signal: AbortSignal) => {
        await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }))
        return { getUpdatesBuf: 'next', messages: [] }
      })
    const client = {
      setBaseUrl: vi.fn(),
      setBotToken: vi.fn(),
      getUpdates,
      sendTextMessage: vi.fn(),
    } as unknown as WechatApiClient
    const adapter = new WechatClawAdapter({ client, sessionStore: store, onMessage: async () => {}, retryDelayMs: 0 })
    const controller = new AbortController()

    const running = adapter.start(controller.signal)
    await vi.waitFor(() => expect(getUpdates).toHaveBeenCalledTimes(2))
    expect(saved[0]?.metadata.sessionExpired).toBe(true)
    controller.abort()
    await running
  })

  it('does not block the next poll while DSH handles a previous message', async () => {
    const store: SessionStore = {
      async load() { return structuredClone(session) },
      async save() {},
      async clear() {},
    }
    let releaseDispatch: (() => void) | undefined
    const dispatchStarted = new Promise<void>((resolve) => { releaseDispatch = resolve })
    const getUpdates = vi.fn()
      .mockResolvedValueOnce({ getUpdatesBuf: 'next-1', messages: [{
        message_type: 1, message_id: 'slow-1', from_user_id: 'user-1', context_token: 'ctx-1',
        item_list: [{ type: 1, text_item: { text: 'slow' } }],
      }] })
      .mockImplementationOnce(async (_cursor: string, signal: AbortSignal) => {
        releaseDispatch?.()
        await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }))
        return { getUpdatesBuf: 'next-2', messages: [] }
      })
    const client = {
      setBaseUrl: vi.fn(),
      setBotToken: vi.fn(),
      getUpdates,
      sendTextMessage: vi.fn(),
    } as unknown as WechatApiClient
    const dispatch = new Promise<void>((resolve) => setTimeout(resolve, 1000))
    const adapter = new WechatClawAdapter({
      client,
      sessionStore: store,
      onMessage: async () => {
        await dispatch
      },
      retryDelayMs: 0,
    })
    const controller = new AbortController()
    const running = adapter.start(controller.signal)
    await vi.waitFor(() => expect(getUpdates).toHaveBeenCalledTimes(2))
    expect(getUpdates.mock.calls[1][0]).toBe('next-1')
    controller.abort()
    await running
    await dispatchStarted
  })
})
