import { WechatDshSessionRouter, formatWechatMarkdown, type HostApiProxy } from '../src/dsh/wechat-session-router.js'
import type { EveryConnectSettings, SettingsStore } from '../src/session/store.js'
import type { InboundMessage } from '../src/platform/types.js'

function message(text: string, senderId = 'wechat-user'): InboundMessage {
  return {
    platform: 'wechat-claw',
    accountId: 'bot',
    conversationId: senderId,
    senderId,
    messageId: `m-${text}`,
    text,
    receivedAt: 1,
    replyContext: { contextToken: 'context' },
    rawType: 'text',
  }
}

function apiWithSessions(count = 2) {
  const prompts: unknown[] = []
  const api: HostApiProxy = {
    workspace: {
      list: vi.fn(async () => ({ result: { ok: true, value: {
        items: [{ workspaceId: 'workspace-a', path: 'E:/workspace', title: '工作区 A', sessionIds: Array.from({ length: count }, (_, index) => `session-${index + 1}`) }],
        archivedSessionIds: [],
      } } })),
    },
    sessions: {
      list: vi.fn(async () => ({ result: { ok: true, value: {
        items: Array.from({ length: count }, (_, index) => ({
          sessionId: `session-${index + 1}`,
          updatedAt: index,
          running: false,
          blank: false,
          cwd: `E:/workspace/task-${index + 1}`,
        })),
      } } })),
      prompt: vi.fn(async (request) => {
        prompts.push(request)
        return { result: { ok: true, value: { accepted: true } } }
      }),
    },
  }
  return { api, prompts }
}

describe('WechatDshSessionRouter', () => {
  it('shows a menu, selects a session, and forwards later messages', async () => {
    const { api, prompts } = apiWithSessions()
    const replies: string[] = []
    const router = new WechatDshSessionRouter(api, async (_senderId, text) => { replies.push(text) })

    await router.handle(message('hello'), new AbortController().signal)
    expect(replies[0]).toContain('**工作区-任务会话**')
    expect(replies[0]).toContain('1. task-1')
    expect(replies[0]).toContain('`/help` 查看命令指引。')
    expect(replies[0]).toContain('`/setting` 打开整体设置；进入会话后打开会话设置。')
    expect(replies[0]).toContain('`/config` 查看当前会话信息（会话中可用）。')
    expect(replies[0]).toContain('`/stop` 暂停当前会话任务（会话中可用）。')
    expect(replies[0]).toContain('`/new` 新建菜单；`/new workspace` 新建工作目录；`/new task` 新建任务。')
    expect(prompts).toHaveLength(0)

    await router.handle(message('1'), new AbortController().signal)
    expect(replies[1]).toMatch(/^`task-1`\n/)
    expect(replies[1]).toContain('输入 `/help` 获取命令指引。')
    await router.handle(message('/help'), new AbortController().signal)
    expect(replies[2]).toMatch(/^`task-1`\n\*\*命令指引\*\*/)
    await router.handle(message('send this'), new AbortController().signal)
    expect(prompts).toHaveLength(1)
    expect((prompts[0] as { payload: { sessionId: string; content: Array<{ text: string }> } }).payload).toMatchObject({
      sessionId: 'session-1',
      content: [{ type: 'text', text: 'send this' }],
    })
  })

  it('exits the selected session with /exit and /home', async () => {
    const { api, prompts } = apiWithSessions()
    const replies: string[] = []
    const router = new WechatDshSessionRouter(api, async (_senderId, text) => { replies.push(text) })
    const signal = new AbortController().signal

    await router.handle(message('/'), signal)
    await router.handle(message('1'), signal)
    await router.handle(message('/exit'), signal)
    await router.handle(message('after exit'), signal)
    await router.handle(message('/home'), signal)
    await router.handle(message('after home'), signal)

    expect(prompts).toHaveLength(0)
    expect(replies.filter((reply) => reply.includes('**工作区-任务会话**')).length).toBeGreaterThanOrEqual(3)
  })

  it('cancels the active session task with /stop', async () => {
    const { api } = apiWithSessions()
    const cancels: unknown[] = []
    api.sessions.cancel = vi.fn(async (request) => {
      cancels.push(request)
      return { result: { ok: true, value: { accepted: true } } }
    })
    const replies: string[] = []
    const typing: boolean[] = []
    const router = new WechatDshSessionRouter(api, async (_senderId, text) => { replies.push(text) }, async (_senderId, _contextToken, isTyping) => { typing.push(isTyping) })
    const signal = new AbortController().signal

    await router.handle(message('/'), signal)
    await router.handle(message('1'), signal)
    await router.handle(message('/stop'), signal)

    expect(cancels).toHaveLength(1)
    expect((cancels[0] as { payload: { sessionId: string } }).payload.sessionId).toBe('session-1')
    expect(replies.at(-1)).toMatch(/^`task-1`\n已请求暂停当前任务。$/)
    expect(typing).toEqual([false])
  })

  it('creates a workspace directory and a task from the WeChat menu', async () => {
    const { api } = apiWithSessions()
    const directories: unknown[] = []
    const workspaces: unknown[] = []
    const sessions: unknown[] = []
    const renames: unknown[] = []
    api.host = {
      createDirectory: vi.fn(async (request) => {
        directories.push(request)
        return { result: { ok: true, value: { path: 'E:/workspace/new-project' } } }
      }),
    }
    api.workspace.create = vi.fn(async (request) => {
      workspaces.push(request)
      return { result: { ok: true, value: { workspace: { workspaceId: 'workspace-new', title: 'new-project', path: 'E:/workspace/new-project', sessionIds: [] }, created: true } } }
    })
    api.sessions.create = vi.fn(async (request) => {
      sessions.push(request)
      return { result: { ok: true, value: { sessionId: 'session-new' } } }
    })
    api.sessions.rename = vi.fn(async (request) => {
      renames.push(request)
      return { result: { ok: true, value: { title: '新任务', seq: 1 } } }
    })
    const replies: string[] = []
    const router = new WechatDshSessionRouter(api, async (_senderId, text) => { replies.push(text) })
    const signal = new AbortController().signal

    await router.handle(message('/new'), signal)
    expect(replies.at(-1)).toContain('1. 新建工作目录')
    await router.handle(message('1'), signal)
    await router.handle(message('E:/workspace'), signal)
    await router.handle(message('new-project'), signal)
    expect(directories).toEqual([{ rpcId: expect.any(String), payload: { path: 'E:/workspace', name: 'new-project' } }])
    expect(workspaces).toEqual([{ rpcId: expect.any(String), payload: { path: 'E:/workspace/new-project' } }])

    await router.handle(message('/new task'), signal)
    await router.handle(message('1'), signal)
    await router.handle(message('新任务'), signal)
    expect(sessions).toEqual([{ rpcId: expect.any(String), payload: { workspaceId: 'workspace-a' } }])
    expect(renames).toEqual([{ rpcId: expect.any(String), payload: { sessionId: 'session-new', title: '新任务' } }])
    expect(replies.at(-1)).toContain('已新建任务：**新任务**')
    expect(replies.at(-1)).toMatch(/^`新任务`\n/)
  })

  it('keeps concurrent users on separate sessions and does not forward slash commands', async () => {
    const { api, prompts } = apiWithSessions()
    const cancels: unknown[] = []
    api.sessions.cancel = vi.fn(async (request) => {
      cancels.push(request)
      return { result: { ok: true, value: { accepted: true } } }
    })
    const replies: Array<{ senderId: string; text: string }> = []
    const router = new WechatDshSessionRouter(api, async (senderId, text) => { replies.push({ senderId, text }) })
    const signal = new AbortController().signal

    await Promise.all([
      router.handle(message('/', 'alice'), signal),
      router.handle(message('/', 'bob'), signal),
    ])
    await Promise.all([
      router.handle(message('1', 'alice'), signal),
      router.handle(message('2', 'bob'), signal),
    ])
    await Promise.all([
      router.handle(message('alice task', 'alice'), signal),
      router.handle(message('/stop', 'bob'), signal),
    ])

    expect(prompts).toHaveLength(1)
    expect((prompts[0] as { payload: { sessionId: string } }).payload.sessionId).toBe('session-1')
    expect(cancels).toHaveLength(1)
    expect((cancels[0] as { payload: { sessionId: string } }).payload.sessionId).toBe('session-2')
    expect(replies.some(({ senderId, text }) => senderId === 'bob' && text.includes('已请求暂停当前任务'))).toBe(true)
  })

  it('pages at twenty sessions', async () => {
    const { api } = apiWithSessions(21)
    const replies: string[] = []
    const router = new WechatDshSessionRouter(api, async (_senderId, text) => { replies.push(text) })
    const signal = new AbortController().signal

    await router.handle(message('/'), signal)
    expect(replies[0].match(/^\d+\./gm)).toHaveLength(20)
    await router.handle(message('/next'), signal)
    expect(replies[1]).toContain('21. task-21')
    expect(replies[1].match(/^\d+\./gm)).toHaveLength(1)
  })

  it('forwards assistant text and keeps WeChat markdown supported', async () => {
    const { api } = apiWithSessions()
    const replies: string[] = []
    const typing: boolean[] = []
    const router = new WechatDshSessionRouter(api, async (_senderId, text) => { replies.push(text) }, async (_senderId, _contextToken, isTyping) => { typing.push(isTyping) })
    const signal = new AbortController().signal

    await router.handle(message('/'), signal)
    await router.handle(message('1'), signal)
    await router.handle(message('question'), signal)
    await router.handleEvent({ id: 'session-1' }, {
      type: 'assistant/message',
      data: { message: { content: [{ type: 'text', text: '# **done**\n\n```ts\nconst x = 1\n```\n[link](https://example.test)' }] } },
    })

    expect(replies.at(-1)).toMatch(/^`task-1`\n/)
    expect(replies.at(-1)).toContain('**done**')
    expect(replies.at(-1)).toContain('`const x = 1`')
    expect(replies.at(-1)).toContain('link')
    expect(replies.at(-1)).not.toContain('https://example.test')
    expect(typing).toEqual([true, false])
    expect(formatWechatMarkdown('~~strike~~ *italic* `code`')).toBe('~~strike~~ *italic* `code`')
  })

  it('keeps assistant output realtime by default and does not duplicate the final message', async () => {
    const { api } = apiWithSessions()
    const replies: string[] = []
    const router = new WechatDshSessionRouter(api, async (_senderId, text) => { replies.push(text) })
    const signal = new AbortController().signal

    await router.handle(message('/'), signal)
    await router.handle(message('1'), signal)
    await router.handleEvent({ id: 'session-1' }, {
      type: 'assistant/chunk',
      data: { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: '实时' } },
    })
    await router.handleEvent({ id: 'session-1' }, {
      type: 'assistant/message',
      data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: '实时' }] } },
    })

    expect(replies.filter((reply) => reply.includes('实时'))).toHaveLength(1)
  })

  it('batches realtime chunks so the session name is not repeated for every token', async () => {
    const { api } = apiWithSessions()
    const replies: string[] = []
    const router = new WechatDshSessionRouter(api, async (_senderId, text) => { replies.push(text) })
    const signal = new AbortController().signal

    await router.handle(message('/'), signal)
    await router.handle(message('1'), signal)
    await router.handleEvent({ id: 'session-1' }, {
      type: 'assistant/chunk',
      data: { turn: 1, step: 1, chunk: { type: 'text-delta', text: '你好' } },
    })
    await router.handleEvent({ id: 'session-1' }, {
      type: 'assistant/chunk',
      data: { turn: 1, step: 1, chunk: { type: 'text-delta', text: '，世界' } },
    })
    await new Promise((resolve) => setTimeout(resolve, 220))

    const streamedReplies = replies.filter((reply) => reply.includes('你好'))
    expect(streamedReplies).toHaveLength(1)
    expect(streamedReplies[0]).toBe('`task-1`\n你好，世界')
  })

  it('shows and changes global and session settings', async () => {
    const { api } = apiWithSessions()
    const prompts: unknown[] = []
    const models = vi.fn(async () => ({ result: { ok: true, value: {
      current: { provider: 'provider-a', model: 'model-a' },
      groups: [{ id: 'provider-a', name: 'Provider A', models: [{ id: 'model-a', name: 'Model A' }, { id: 'model-b', name: 'Model B' }] }],
      failures: [],
      routable: true,
    } } }))
    const selectModel = vi.fn(async () => ({ result: { ok: true, value: { selected: { provider: 'provider-a', model: 'model-b' } } } }))
    const originalPrompt = api.sessions.prompt
    const originalList = api.sessions.list
    api.sessions.list = vi.fn(async (request) => {
      const response = await originalList(request) as { result: { ok: true; value: { items: Array<Record<string, unknown>> } } }
      return {
        result: {
          ok: true,
          value: {
            ...response.result.value,
            items: response.result.value.items.map((item) => item.sessionId === 'session-1' ? {
              ...item,
              projections: {
                asOfSeq: 10,
                values: {
                  sessionStats: { turns: 2, steps: 5, llmMs: 1234, toolMs: 2000, ttftMs: 400, ttftSteps: 2, decodeMs: 800, decodeTokens: 40 },
                  tokenUsage: { uncachedInputTokens: 100, cacheReadTokens: 300, cacheWriteTokens: 0, outputTokens: 40 },
                  permissions: { currentValue: 'workspace-write', options: [{ value: 'workspace-write', name: 'workspace-write' }] },
                },
              },
            } : item),
          },
        },
      }
    })
    api.sessions.models = models
    api.sessions.selectModel = selectModel
    api.sessions.prompt = vi.fn(async (request) => {
      prompts.push(request)
      return originalPrompt(request)
    })
    const settings: EveryConnectSettings = { mergeAssistantInfo: false }
    const store: SettingsStore = {
      load: vi.fn(async () => ({ ...settings })),
      save: vi.fn(async (next) => { settings.mergeAssistantInfo = next.mergeAssistantInfo }),
    }
    const replies: string[] = []
    const router = new WechatDshSessionRouter(api, async (_senderId, text) => { replies.push(text) }, undefined, store)
    const signal = new AbortController().signal

    await router.handle(message('/setting'), signal)
    expect(replies.at(-1)).toContain('合并发送 Assistant 信息：关闭')
    await router.handle(message('1'), signal)
    expect(settings.mergeAssistantInfo).toBe(true)

    await router.handle(message('/'), signal)
    await router.handle(message('1'), signal)
    await router.handle(message('/setting'), signal)
    expect(replies.at(-1)).toContain('**会话设置**')
    await router.handle(message('1'), signal)
    expect(replies.at(-1)).toContain('Provider A / Model B')
    await router.handle(message('2'), signal)
    expect(selectModel).toHaveBeenCalledWith(expect.objectContaining({ payload: expect.objectContaining({ model: 'model-b' }) }))
    expect(replies.at(-1)).toContain('**会话设置**')
    await router.handle(message('2'), signal)
    expect(replies.at(-1)).toContain('**模型模式**')
    await router.handle(message('1'), signal)
    expect(prompts).toHaveLength(1)
    expect((prompts[0] as { payload: { content: Array<{ text: string }> } }).payload.content[0].text).toBe('/permission workspace-write')

    await router.handle(message('/config'), signal)
    expect(replies.at(-1)).toContain('2 轮 · 5 步')
    expect(replies.at(-1)).toContain('模型 1.2s · 工具 2s')
    expect(replies.at(-1)).toContain('缓存命中：75% · 输入 400 · 输出 40')
  })
})
