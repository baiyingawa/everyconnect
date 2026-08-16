import { mkdir, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { InboundAttachment } from '../platform/types.js'

export interface MediaStoreOptions {
  rootPath?: string
}

export class FileMediaStore {
  private readonly rootPath: string

  constructor(options: MediaStoreOptions = {}) {
    this.rootPath = options.rootPath || join(homedir(), '.dsh', 'everyconnect', 'inbox')
  }

  async save(messageId: string, attachment: InboundAttachment, data: Uint8Array, signal: AbortSignal): Promise<string> {
    signal.throwIfAborted()
    const safeMessageId = messageId.replace(/[^a-zA-Z0-9._-]/g, '_').slice(-80) || 'message'
    const safeName = attachment.fileName.replace(/[^a-zA-Z0-9._\-\u4e00-\u9fff]/g, '_') || 'attachment'
    const directory = join(this.rootPath, safeMessageId)
    const path = join(directory, safeName)
    await mkdir(directory, { recursive: true })
    signal.throwIfAborted()
    await writeFile(path, data)
    return path
  }
}
