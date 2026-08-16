import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

export interface EveryConnectSession {
  auth: {
    botToken: string
    ilinkBotId: string
    ilinkUserId: string
    baseUrl: string
  }
  cursor: {
    getUpdatesBuf: string
    longPollingTimeoutMs?: number
  }
  contextTokens: Record<string, string>
  metadata: {
    createdAt: number
    lastActiveAt: number
    sessionExpired: boolean
    recentMessageIds?: string[]
  }
}

export interface SessionStore {
  load(signal: AbortSignal): Promise<EveryConnectSession | null>
  save(session: EveryConnectSession, signal: AbortSignal): Promise<void>
  clear(signal: AbortSignal): Promise<void>
}

export interface EveryConnectSettings {
  mergeAssistantInfo: boolean
}

export interface SettingsStore {
  load(signal: AbortSignal): Promise<EveryConnectSettings>
  save(settings: EveryConnectSettings, signal: AbortSignal): Promise<void>
}

export const DEFAULT_EVERYCONNECT_SETTINGS: EveryConnectSettings = {
  mergeAssistantInfo: false,
}

export function createSession(input: {
  botToken: string
  ilinkBotId: string
  ilinkUserId: string
  baseUrl: string
}, now = Date.now()): EveryConnectSession {
  return {
    auth: input,
    cursor: { getUpdatesBuf: '' },
    contextTokens: {},
    metadata: { createdAt: now, lastActiveAt: now, sessionExpired: false, recentMessageIds: [] },
  }
}

export class SessionStoreError extends Error {
  constructor(message: string, readonly code: 'SESSION_STORE_CORRUPT' | 'SESSION_STORE_IO') {
    super(message)
    this.name = 'SessionStoreError'
  }
}

export class FileSessionStore implements SessionStore {
  constructor(private readonly filePath: string) {}

  async load(signal: AbortSignal): Promise<EveryConnectSession | null> {
    signal.throwIfAborted()
    try {
      const raw = await readFile(this.filePath, { encoding: 'utf8', signal })
      return parseSession(raw)
    } catch (error) {
      if (isMissingFile(error)) return null
      if (error instanceof SessionStoreError) throw error
      if (isAbort(error)) throw error
      throw new SessionStoreError(`Failed to read session store: ${this.filePath}`, 'SESSION_STORE_IO')
    }
  }

  async save(session: EveryConnectSession, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    const temporaryPath = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`
    try {
      await mkdir(dirname(this.filePath), { recursive: true })
      await writeFile(temporaryPath, JSON.stringify(session, null, 2), { encoding: 'utf8', signal })
      signal.throwIfAborted()
      await rename(temporaryPath, this.filePath)
    } catch (error) {
      if (isAbort(error)) throw error
      throw new SessionStoreError(`Failed to write session store: ${this.filePath}`, 'SESSION_STORE_IO')
    } finally {
      await rm(temporaryPath, { force: true }).catch(() => undefined)
    }
  }

  async clear(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    await rm(this.filePath, { force: true })
  }
}

export class FileSettingsStore implements SettingsStore {
  constructor(private readonly filePath: string) {}

  async load(signal: AbortSignal): Promise<EveryConnectSettings> {
    signal.throwIfAborted()
    try {
      const raw = await readFile(this.filePath, { encoding: 'utf8', signal })
      return parseSettings(raw)
    } catch (error) {
      if (isMissingFile(error)) return { ...DEFAULT_EVERYCONNECT_SETTINGS }
      if (error instanceof SessionStoreError) throw error
      if (isAbort(error)) throw error
      throw new SessionStoreError(`Failed to read settings store: ${this.filePath}`, 'SESSION_STORE_IO')
    }
  }

  async save(settings: EveryConnectSettings, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    const temporaryPath = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`
    try {
      await mkdir(dirname(this.filePath), { recursive: true })
      await writeFile(temporaryPath, JSON.stringify(settings, null, 2), { encoding: 'utf8', signal })
      signal.throwIfAborted()
      await rename(temporaryPath, this.filePath)
    } catch (error) {
      if (isAbort(error)) throw error
      throw new SessionStoreError(`Failed to write settings store: ${this.filePath}`, 'SESSION_STORE_IO')
    } finally {
      await rm(temporaryPath, { force: true }).catch(() => undefined)
    }
  }
}

function parseSession(raw: string): EveryConnectSession {
  try {
    const value = JSON.parse(raw) as unknown
    if (!isSession(value)) throw new Error('shape')
    return value
  } catch {
    throw new SessionStoreError('Session store contains invalid JSON or shape', 'SESSION_STORE_CORRUPT')
  }
}

function parseSettings(raw: string): EveryConnectSettings {
  try {
    const value = JSON.parse(raw) as unknown
    if (typeof value !== 'object' || value === null || typeof (value as Record<string, unknown>).mergeAssistantInfo !== 'boolean') {
      throw new Error('shape')
    }
    return { mergeAssistantInfo: (value as { mergeAssistantInfo: boolean }).mergeAssistantInfo }
  } catch {
    throw new SessionStoreError('Settings store contains invalid JSON or shape', 'SESSION_STORE_CORRUPT')
  }
}

function isSession(value: unknown): value is EveryConnectSession {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  const auth = record.auth as Record<string, unknown> | undefined
  const cursor = record.cursor as Record<string, unknown> | undefined
  const metadata = record.metadata as Record<string, unknown> | undefined
  return Boolean(
    auth && typeof auth.botToken === 'string' && typeof auth.ilinkBotId === 'string' &&
      typeof auth.ilinkUserId === 'string' && typeof auth.baseUrl === 'string' &&
      cursor && typeof cursor.getUpdatesBuf === 'string' &&
      typeof record.contextTokens === 'object' && record.contextTokens !== null &&
      metadata && typeof metadata.createdAt === 'number' && typeof metadata.lastActiveAt === 'number' &&
      typeof metadata.sessionExpired === 'boolean' &&
      (metadata.recentMessageIds === undefined || (Array.isArray(metadata.recentMessageIds) && metadata.recentMessageIds.every((id) => typeof id === 'string'))),
  )
}

function isMissingFile(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
}

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
}
