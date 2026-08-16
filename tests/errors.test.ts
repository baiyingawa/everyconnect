import { classifyApiError } from '../src/wechat/errors.js'

describe('WeChat error classification', () => {
  it('recognizes session expiry and retryable HTTP responses', () => {
    expect(classifyApiError(200, -14)).toBe('session-expired')
    expect(classifyApiError(429)).toBe('retryable')
    expect(classifyApiError(503)).toBe('retryable')
    expect(classifyApiError(400)).toBe('invalid-payload')
    expect(classifyApiError(200)).toBe('fatal')
  })
})
