export interface EffectContext {
  effect(factory: () => void | (() => void), label?: string): void
}

export interface PollingService {
  start(signal: AbortSignal): void | Promise<void>
  stop(): void | Promise<void>
}

export function bindPollingLifecycle(ctx: EffectContext, poller: PollingService): void {
  ctx.effect(() => {
    const controller = new AbortController()
    void Promise.resolve(poller.start(controller.signal)).catch((error) => {
      if (!controller.signal.aborted) console.error('[everyconnect] polling stopped:', error)
    })
    return () => {
      controller.abort()
      void Promise.resolve(poller.stop()).catch((error) => {
        console.error('[everyconnect] polling cleanup failed:', error)
      })
    }
  }, 'everyconnect: polling lifecycle')
}
