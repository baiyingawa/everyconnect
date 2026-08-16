import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FileSessionStore, type EveryConnectSession } from '../src/session/store.js'

const session: EveryConnectSession = {
  auth: { botToken: 'bot', ilinkBotId: 'bot-id', ilinkUserId: 'user-id', baseUrl: 'https://example.test' },
  cursor: { getUpdatesBuf: 'cursor', longPollingTimeoutMs: 35000 },
  contextTokens: { 'user-1': 'context-1' },
  metadata: { createdAt: 1, lastActiveAt: 2, sessionExpired: false },
}

describe('FileSessionStore', () => {
  it('writes through a temporary file and reloads the same session', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'everyconnect-'))
    const path = join(directory, 'session.json')
    const store = new FileSessionStore(path)
    try {
      await store.save(session, new AbortController().signal)
      expect(await store.load(new AbortController().signal)).toEqual(session)
      expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(session)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('honors an already aborted signal', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'everyconnect-'))
    const store = new FileSessionStore(join(directory, 'session.json'))
    const controller = new AbortController()
    controller.abort()
    try {
      await expect(store.save(session, controller.signal)).rejects.toThrow()
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
