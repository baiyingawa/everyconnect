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
    void poller.start(controller.signal)
    return () => {
      controller.abort()
      void poller.stop()
    }
  }, 'everyconnect: polling lifecycle')
}
