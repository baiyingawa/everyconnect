import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FileMediaStore } from '../src/session/media-store.js'

describe('FileMediaStore', () => {
  it('persists an attachment under a message-specific directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'everyconnect-media-'))
    try {
      const store = new FileMediaStore({ rootPath: root })
      const path = await store.save('message/1', {
        kind: 'file', fileName: 'report.pdf', mimeType: 'application/pdf',
      }, new TextEncoder().encode('data'), new AbortController().signal)
      expect(path).toContain('message_1')
      expect(await readFile(path, 'utf8')).toBe('data')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
