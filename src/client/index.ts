import { createElement as h } from 'react'
import * as primitives from '@deepseek-ai/dsh-client-ui-primitives'
import { EveryConnectSection } from './EveryConnectSection.js'
import { en, zh, type EveryConnectLocale } from './locales.js'

const NS = 'everyconnect'
const REQUIRED_PRIMITIVES = ['Button', 'Input', 'DisclosureRow', 'StateDot', 'IconLinkOutline14'] as const

interface LocaleService {
  register(namespace: string, dicts: { zh: Record<string, string>; en: Record<string, string> }): unknown
  bind(namespace: string): (key: keyof EveryConnectLocale) => string
}

interface SlotsService {
  inject(slot: string, register: () => unknown): void
  register(meta: Record<string, unknown>, component: () => unknown): unknown
}

interface EveryConnectClientContext {
  effect(callback: () => unknown, label?: string): void
  locale: LocaleService
  slots: SlotsService
}

export const name = 'everyconnect-client'
export const inject = ['slots', 'locale']

export function apply(ctx: EveryConnectClientContext): void {
  const missing = REQUIRED_PRIMITIVES.filter((key) => (primitives as Record<string, unknown>)[key] === undefined)
  if (missing.length > 0) {
    console.warn('[everyconnect] settings section disabled; host primitives missing: ' + missing.join(', '))
    return
  }

  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'everyconnect: dictionaries')
  const t = ctx.locale.bind(NS)

  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'everyconnect',
    order: 45,
    label: () => t('nav'),
    locale: NS,
    inject: () => ({ t }),
  }, () => h(EveryConnectSection, { t })))
}
