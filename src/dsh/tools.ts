export interface RawJsonSchemaTool {
  name: string
  description: string
  parameters: {
    type: 'object'
    properties: Record<string, unknown>
    additionalProperties: boolean
  }
  output: {
    schema: Record<string, unknown>
    render(args: unknown, value: unknown): Array<{ type: 'text'; text: string }>
  }
  execute(args: unknown): Promise<unknown>
}

export interface ToolRegistryContext {
  tools?: {
    register(tool: RawJsonSchemaTool): void
  }
}

export function createConnectionStatusTool(getStatus: () => unknown): RawJsonSchemaTool {
  return {
    name: 'everyconnect_status',
    description: 'Return EveryConnect platform connection status.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          status: { type: 'object', additionalProperties: true },
        },
        required: ['ok', 'status'],
      },
      render(_args, value) {
        return [{ type: 'text', text: JSON.stringify(value) }]
      },
    },
    async execute(args: unknown) {
      if (!isEmptyObject(args)) throw new Error('everyconnect_status accepts no arguments')
      return { ok: true, status: getStatus() }
    },
  }
}

export function registerRawTool(ctx: ToolRegistryContext, tool: RawJsonSchemaTool): void {
  ctx.tools?.register(tool)
}

function isEmptyObject(value: unknown): value is Record<string, never> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && Object.keys(value).length === 0
}
