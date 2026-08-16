import { useEffect, useMemo, useState, type CSSProperties } from 'react'
import { toDataURL } from 'qrcode/lib/browser.js'
import {
  Button,
  DisclosureRow,
  IconCheckOutline16,
  IconChevronDownOutline14,
  IconChevronUpOutline14,
  IconLinkOutline14,
  IconRefreshOutline14,
  Input,
  StateDot,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { EveryConnectLocale } from './locales.js'

const STORAGE_KEY = 'everyconnect.settings.v1'
const DEFAULTS = {
  enabled: false,
  baseUrl: 'https://ilinkai.weixin.qq.com',
  sessionStore: '~/.dsh/everyconnect/session.json',
  allowFrom: '',
}

type Settings = typeof DEFAULTS
type Translate = (key: keyof EveryConnectLocale) => string
type QrStatus =
  | { state: 'idle' | 'requesting' | 'confirmed' | 'expired' | 'canceled' }
  | { state: 'waiting_scan' | 'scanned'; qrImageUrl: string }
  | { state: 'error'; message: string }
type ConnectionStatus = { enabled: boolean; connected: boolean; sessionExpired: boolean }

export function EveryConnectSection({ t }: { t: Translate }) {
  const [settings, setSettings] = useState<Settings>(() => loadSettings())
  const [draft, setDraft] = useState<Settings>(settings)
  const [open, setOpen] = useState(true)
  const [notice, setNotice] = useState('')
  const [qrStatus, setQrStatus] = useState<QrStatus>({ state: 'idle' })
  const [qrBusy, setQrBusy] = useState(false)
  const [qrAttempt, setQrAttempt] = useState(0)
  const [qrDataUrl, setQrDataUrl] = useState('')
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>({ enabled: false, connected: false, sessionExpired: false })

  useEffect(() => {
    let active = true
    const readConnectionStatus = async () => {
      try {
        const response = await fetch('/api/everyconnect/wechat/status')
        if (!response.ok) return
        const status = await response.json() as ConnectionStatus
        if (!active) return
        setConnectionStatus(status)
        if (status.enabled) {
          setSettings((current) => ({ ...current, enabled: true }))
          setDraft((current) => ({ ...current, enabled: true }))
        }
      } catch {
        // The QR polling effect shows the visible Host error state.
      }
    }
    void readConnectionStatus()
    const timer = setInterval(() => void readConnectionStatus(), 3000)
    return () => { active = false; clearInterval(timer) }
  }, [])

  useEffect(() => {
    setDraft(settings)
  }, [settings])

  useEffect(() => {
    if (!('qrImageUrl' in qrStatus)) {
      setQrDataUrl('')
      return
    }

    let active = true
    setQrDataUrl('')
    void toDataURL(qrStatus.qrImageUrl, {
      width: 250,
      margin: 2,
      errorCorrectionLevel: 'M',
    }).then((dataUrl) => {
      if (active) setQrDataUrl(dataUrl)
    }).catch(() => {
      if (active) setQrDataUrl('')
    })
    return () => { active = false }
  }, [qrStatus])

  useEffect(() => {
    if (!draft.enabled || connectionStatus.connected) {
      setQrStatus({ state: 'idle' })
      return
    }

    const controller = new AbortController()
    let timer: ReturnType<typeof setInterval> | undefined
    let disposed = false

    const readStatus = async () => {
      const response = await fetch('/api/everyconnect/wechat/qr/status', { signal: controller.signal })
      if (!response.ok) throw new Error(`Host returned HTTP ${response.status}`)
      return response.json() as Promise<QrStatus>
    }

    const poll = async () => {
      try {
        const status = await readStatus()
        if (!disposed) setQrStatus(status)
      } catch (error) {
        if (!disposed && !controller.signal.aborted) setQrStatus({ state: 'error', message: error instanceof Error ? error.message : String(error) })
      }
    }

    const start = async () => {
      setQrBusy(true)
      try {
        const response = await fetch('/api/everyconnect/wechat/qr/start', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ baseUrl: draft.baseUrl }),
          signal: controller.signal,
        })
        if (!response.ok) throw new Error(`Host returned HTTP ${response.status}`)
        const status = await response.json() as QrStatus
        if (!disposed) setQrStatus(status)
      } catch (error) {
        if (!disposed && !controller.signal.aborted) setQrStatus({ state: 'error', message: error instanceof Error ? error.message : String(error) })
      } finally {
        if (!disposed) setQrBusy(false)
      }
    }

    void start()
    timer = setInterval(() => void poll(), 1500)
    return () => {
      disposed = true
      controller.abort()
      if (timer) clearInterval(timer)
    }
  }, [draft.enabled, draft.baseUrl, qrAttempt, connectionStatus.connected])

  const isDirty = useMemo(() => JSON.stringify(settings) !== JSON.stringify(draft), [settings, draft])
  const effectiveEnabled = draft.enabled || connectionStatus.enabled
  const statusState = effectiveEnabled ? 'done' : 'warning'

  const update = <K extends keyof Settings>(key: K, value: Settings[K]) => {
    setDraft((current) => ({ ...current, [key]: value }))
    setNotice('')
  }

  const save = () => {
    const next = normalize(draft)
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
    setSettings(next)
    setNotice(t('saved'))
  }

  const reset = () => {
    localStorage.removeItem(STORAGE_KEY)
    setSettings(DEFAULTS)
    setDraft(DEFAULTS)
    setNotice(t('resetDone'))
  }

  return (
    <div style={styles.root}>
      <div style={styles.heading}>
        <div>
          <h2 style={styles.title}>{t('title')}</h2>
          <p style={styles.subtitle}>{t('subtitle')}</p>
        </div>
        <StateDot state={statusState} size={8} />
      </div>

      <section style={styles.card}>
        <div style={styles.cardHeader}>
          <div style={styles.leadingIcon}><IconLinkOutline14 size={18} /></div>
          <div style={styles.grow}>
            <div style={styles.cardTitle}>{t('wechatTitle')}</div>
            <div style={styles.cardDescription}>{t('wechatDescription')}</div>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={effectiveEnabled}
            aria-label={t('enabled')}
            onClick={() => update('enabled', !draft.enabled)}
            style={{ ...styles.switch, ...(effectiveEnabled ? styles.switchOn : {}) }}
          >
            <span style={{ ...styles.knob, ...(effectiveEnabled ? styles.knobOn : {}) }} />
          </button>
        </div>
        <div style={styles.statusLine}>
          <StateDot state={effectiveEnabled ? 'ongoing' : 'warning'} size={7} />
          <span>{effectiveEnabled ? t('enabledOn') : t('enabledOff')}</span>
          <span style={styles.statusHint}>{effectiveEnabled ? (connectionStatus.connected ? t('qrConfirmed') : qrStatusLabel(qrStatus, t)) : t('statusPending')}</span>
        </div>
      </section>

      {effectiveEnabled && !connectionStatus.connected && (
        <section style={styles.qrCard} aria-live="polite">
          <div style={styles.qrHeader}>
            <div style={styles.grow}>
              <div style={styles.cardTitle}>{t('qrTitle')}</div>
              <div style={styles.qrMessage}>{qrStatusLabel(qrStatus, t)}</div>
            </div>
            {(qrStatus.state === 'expired' || qrStatus.state === 'canceled' || qrStatus.state === 'error') && (
              <Button variant="ghost" size="sm" icon={<IconRefreshOutline14 size={15} />} disabled={qrBusy} onClick={() => setQrAttempt((value) => value + 1)}>
                {t('qrRetry')}
              </Button>
            )}
          </div>
          {'qrImageUrl' in qrStatus && (
            <div style={styles.qrBody}>
              {qrDataUrl && <img src={qrDataUrl} alt={t('qrTitle')} style={styles.qrImage} />}
              <a href={qrStatus.qrImageUrl} target="_blank" rel="noreferrer" style={styles.qrLink}>{t('qrOpen')}</a>
            </div>
          )}
          {qrStatus.state === 'error' && <div style={styles.error}>{qrStatus.message || t('qrHostUnavailable')}</div>}
        </section>
      )}

      <div style={styles.disclosure}>
        <DisclosureRow
          icon={<IconLinkOutline14 size={16} />}
          title={t('configuration')}
          open={open}
          expandable
          onToggle={() => setOpen((value) => !value)}
          expandOnRowClick
          previewChevron
          collapsedContent={<span style={styles.collapsed}>{draft.baseUrl}</span>}
        >
          {open && (
            <div style={styles.form}>
              <label style={styles.label}>
                <span>{t('baseUrl')}</span>
                <Input
                  value={draft.baseUrl}
                  onChange={(event) => update('baseUrl', event.target.value)}
                  placeholder={t('defaultBaseUrl')}
                  type="url"
                />
              </label>
              <label style={styles.label}>
                <span>{t('sessionStore')}</span>
                <Input
                  value={draft.sessionStore}
                  onChange={(event) => update('sessionStore', event.target.value)}
                />
              </label>
              <label style={styles.label}>
                <span>{t('allowFrom')}</span>
                <textarea
                  value={draft.allowFrom}
                  onChange={(event) => update('allowFrom', event.target.value)}
                  rows={3}
                  style={styles.textarea}
                />
                <small style={styles.hint}>{t('allowFromHint')}</small>
              </label>
            </div>
          )}
        </DisclosureRow>
      </div>

      <p style={styles.loginHint}>{t('loginHint')}</p>

      <div style={styles.actions}>
        <Button
          variant="primary"
          size="sm"
          icon={notice ? <IconCheckOutline16 size={15} /> : undefined}
          disabled={!isDirty}
          onClick={save}
        >
          {notice || t('save')}
        </Button>
        <Button variant="ghost" size="sm" icon={<IconRefreshOutline14 size={15} />} onClick={reset}>
          {t('reset')}
        </Button>
      </div>
    </div>
  )
}

function qrStatusLabel(status: QrStatus, t: Translate): string {
  switch (status.state) {
    case 'requesting': return t('qrRequesting')
    case 'waiting_scan': return t('qrWaiting')
    case 'scanned': return t('qrScanned')
    case 'confirmed': return t('qrConfirmed')
    case 'expired': return t('qrExpired')
    case 'canceled': return t('qrCanceled')
    case 'error': return status.message || t('qrError')
    default: return t('qrHostUnavailable')
  }
}

function loadSettings(): Settings {
  if (typeof localStorage === 'undefined') return DEFAULTS
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}') as Partial<Settings>
    return normalize({ ...DEFAULTS, ...parsed })
  } catch {
    return DEFAULTS
  }
}

function normalize(value: Settings): Settings {
  return {
    enabled: Boolean(value.enabled),
    baseUrl: value.baseUrl.trim() || DEFAULTS.baseUrl,
    sessionStore: value.sessionStore.trim() || DEFAULTS.sessionStore,
    allowFrom: value.allowFrom.trim(),
  }
}

const styles: Record<string, CSSProperties> = {
  root: { minWidth: 0, color: 'var(--dsw-alias-label-primary,#1f2328)', padding: '4px 4px 24px' },
  heading: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '0 0 14px' },
  title: { fontSize: 16, lineHeight: '24px', fontWeight: 500, margin: 0 },
  subtitle: { fontSize: 13, lineHeight: '20px', color: 'var(--dsw-alias-label-tertiary,#8b93a1)', margin: '2px 0 0' },
  card: { background: 'var(--dsw-alias-bg-layer-1,#fff)', border: '1px solid var(--dsw-alias-border-l2,#e5e7eb)', borderRadius: 8, padding: 14, marginBottom: 12 },
  cardHeader: { display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 },
  leadingIcon: { width: 28, height: 28, display: 'grid', placeItems: 'center', color: 'var(--dsw-alias-brand-primary,#4f6ef7)', flexShrink: 0 },
  grow: { flex: 1, minWidth: 0 },
  cardTitle: { fontSize: 14, lineHeight: '20px', fontWeight: 600 },
  cardDescription: { fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-tertiary,#8b93a1)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  qrCard: { background: 'var(--dsw-alias-bg-layer-1,#fff)', border: '1px solid var(--dsw-alias-border-l2,#e5e7eb)', borderRadius: 8, padding: 14, marginBottom: 12 },
  qrHeader: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 },
  qrMessage: { fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-secondary,#6b7280)', marginTop: 2 },
  qrBody: { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8, padding: '14px 0 2px' },
  qrImage: { display: 'block', width: 250, height: 250, objectFit: 'contain', background: '#fff', border: '1px solid var(--dsw-alias-border-l2,#e5e7eb)', borderRadius: 6 },
  qrLink: { fontSize: 12, color: 'var(--dsw-alias-brand-primary,#4f6ef7)', textDecoration: 'none' },
  error: { fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-state-error-primary,#dc2626)', marginTop: 10 },
  switch: { position: 'relative', width: 38, height: 22, borderRadius: 99, border: '1px solid var(--dsw-alias-border-l2,#d9dde3)', background: 'var(--dsw-alias-bg-layer-2,#e5e7eb)', padding: 0, cursor: 'pointer', flexShrink: 0 },
  switchOn: { background: 'var(--dsw-alias-state-success-primary,#16a34a)', borderColor: 'var(--dsw-alias-state-success-primary,#16a34a)' },
  knob: { position: 'absolute', top: 2, left: 2, width: 16, height: 16, borderRadius: 99, background: '#fff', boxShadow: '0 1px 2px rgba(0,0,0,.25)' },
  knobOn: { left: 18 },
  statusLine: { display: 'flex', alignItems: 'center', gap: 7, fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-secondary,#6b7280)', marginTop: 12 },
  statusHint: { color: 'var(--dsw-alias-label-tertiary,#8b93a1)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  disclosure: { borderBottom: '1px solid var(--dsw-alias-border-l2,#e5e7eb)', paddingBottom: 8 },
  collapsed: { fontSize: 11, color: 'var(--dsw-alias-label-tertiary,#8b93a1)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 220 },
  form: { display: 'flex', flexDirection: 'column', gap: 12, padding: '12px 4px 4px' },
  label: { display: 'flex', flexDirection: 'column', gap: 6, fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-secondary,#6b7280)' },
  textarea: { width: '100%', boxSizing: 'border-box', resize: 'vertical', border: '1px solid var(--dsw-alias-border-l2,#e5e7eb)', borderRadius: 6, background: 'var(--dsw-alias-bg-layer-1,#fff)', color: 'var(--dsw-alias-label-primary,#1f2328)', padding: '7px 9px', font: 'inherit', lineHeight: '18px' },
  hint: { fontSize: 11, lineHeight: '16px', color: 'var(--dsw-alias-label-tertiary,#8b93a1)' },
  loginHint: { fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-tertiary,#8b93a1)', margin: '14px 4px 10px' },
  actions: { display: 'flex', alignItems: 'center', gap: 8, padding: '0 4px' },
}
