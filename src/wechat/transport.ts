import { classifyApiError, WechatApiError } from './errors.js'

export type Fetcher = (input: string, init: RequestInit) => Promise<Response>

export async function requestJson(
  fetcher: Fetcher,
  url: string,
  init: RequestInit,
  signal: AbortSignal,
): Promise<unknown> {
  signal.throwIfAborted()
  const response = await fetcher(url, { ...init, signal })
  const text = await response.text()
  let body: unknown = undefined
  if (text) {
    try {
      body = JSON.parse(text) as unknown
    } catch {
      body = undefined
    }
  }

  if (!response.ok) {
    const errcode = getNumber(body, 'errcode')
    throw new WechatApiError(
      `WeChat API request failed with HTTP ${response.status}`,
      classifyApiError(response.status, errcode),
      response.status,
      errcode,
    )
  }
  if (body === undefined) throw new WechatApiError('WeChat API returned invalid JSON', 'invalid-payload', response.status)
  return body
}

function getNumber(value: unknown, key: string): number | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  return key in record && typeof record[key] === 'number'
    ? record[key] as number
    : undefined
}
