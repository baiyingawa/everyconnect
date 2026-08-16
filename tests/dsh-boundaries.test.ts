import { bindPollingLifecycle, createConnectionStatusTool, injectWebServices } from '../src/dsh/index.js'

describe('DSH boundary helpers', () => {
  it('binds polling start and stop to one abortable lifecycle', async () => {
    let cleanup: (() => void) | undefined
    let signal: AbortSignal | undefined
    let stopped = false
    bindPollingLifecycle({ effect(factory) { cleanup = factory() as (() => void) } }, {
      start(startSignal) { signal = startSignal },
      stop() { stopped = true },
    })
    expect(signal?.aborted).toBe(false)
    cleanup?.()
    expect(signal?.aborted).toBe(true)
    expect(stopped).toBe(true)
  })

  it('defers Web service access and validates raw tool arguments', async () => {
    let injected: string[] | undefined
    injectWebServices({ inject(services) { injected = services } }, () => undefined)
    expect(injected).toEqual(['webServer', 'slots'])

    const tool = createConnectionStatusTool(() => 'ready')
    await expect(tool.execute({ unexpected: true })).rejects.toThrow('accepts no arguments')
    await expect(tool.execute({})).resolves.toEqual({ ok: true, status: 'ready' })
  })
})
