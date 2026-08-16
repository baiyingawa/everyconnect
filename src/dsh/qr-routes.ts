import type { IncomingMessage, ServerResponse } from 'node:http'
import { WechatQrLoginService } from '../wechat/qr-login.js'

const START_PATH = '/api/everyconnect/wechat/qr/start'
const STATUS_PATH = '/api/everyconnect/wechat/qr/status'
const CANCEL_PATH = '/api/everyconnect/wechat/qr/cancel'
const CONNECTION_STATUS_PATH = '/api/everyconnect/wechat/status'

export interface WebServerService {
  register(route: {
    kind: 'exact' | 'prefix'
    path: string
    handler: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>
  }): () => void
}

export interface WebRouteContext {
  webServer: WebServerService
  effect(factory: () => void | (() => void | Promise<void>), label?: string): void
}

export interface WebRouteInjectContext {
  inject?(services: string[], callback: (...services: unknown[]) => void): void
}

export function bindWechatQrRoutes(
  ctx: WebRouteInjectContext,
  service = new WechatQrLoginService(),
): void {
  ctx.inject?.(['webServer'], (webServer) => {
    const scope = webServer as WebRouteContext
    scope.effect(() => {
      const disposeStart = scope.webServer.register({ kind: 'exact', path: START_PATH, handler: (req, res) => start(req, res, service) })
      const disposeStatus = scope.webServer.register({ kind: 'exact', path: STATUS_PATH, handler: (_req, res) => sendJson(res, 200, service.getStatus()) })
      const disposeCancel = scope.webServer.register({ kind: 'exact', path: CANCEL_PATH, handler: (_req, res) => sendJson(res, 200, service.cancel()) })
      const disposeConnectionStatus = scope.webServer.register({ kind: 'exact', path: CONNECTION_STATUS_PATH, handler: async (_req, res) => sendJson(res, 200, await service.getConnectionStatus()) })
      return async () => {
        disposeStart()
        disposeStatus()
        disposeCancel()
        disposeConnectionStatus()
        service.dispose()
      }
    }, 'everyconnect: wechat QR routes')
  })
}

async function start(req: IncomingMessage, res: ServerResponse, service: WechatQrLoginService): Promise<void> {
  try {
    const body = await readJson(req)
    const baseUrl = typeof body.baseUrl === 'string' ? body.baseUrl : undefined
    sendJson(res, 200, await service.start(baseUrl))
  } catch (error) {
    sendJson(res, 400, { state: 'error', message: error instanceof Error ? error.message : String(error) })
  }
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > 16 * 1024) throw new Error('request body too large')
    chunks.push(buffer)
  }
  if (chunks.length === 0) return {}
  const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('request body must be an object')
  return value as Record<string, unknown>
}

function sendJson(res: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value)
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Cache-Control', 'no-store')
  res.end(body)
}
