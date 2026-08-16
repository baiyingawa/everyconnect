export interface LazyInjectContext {
  inject?(services: string[], callback: (...services: unknown[]) => void): void
}

export function injectWebServices(
  ctx: LazyInjectContext,
  onReady: (...services: unknown[]) => void,
): void {
  ctx.inject?.(['webServer', 'slots'], onReady)
}
