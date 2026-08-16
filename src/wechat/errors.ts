export type WechatErrorKind =
  | 'aborted'
  | 'session-expired'
  | 'retryable'
  | 'invalid-payload'
  | 'fatal'

export class WechatApiError extends Error {
  constructor(
    message: string,
    readonly kind: WechatErrorKind,
    readonly status?: number,
    readonly errcode?: number,
  ) {
    super(message)
    this.name = 'WechatApiError'
  }
}

export function classifyApiError(status?: number, errcode?: number): WechatErrorKind {
  if (errcode === -14) return 'session-expired'
  if (status === 408 || status === 425 || status === 429 || (status !== undefined && status >= 500)) {
    return 'retryable'
  }
  if (status !== undefined && status >= 400) return 'invalid-payload'
  return 'fatal'
}
