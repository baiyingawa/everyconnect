import { randomUUID } from 'node:crypto'
import type { InboundMessage, OutboundMessage, PlatformAdapter } from '../platform/types.js'
import { DEFAULT_EVERYCONNECT_SETTINGS, type EveryConnectSettings, type SettingsStore } from '../session/store.js'

const PAGE_SIZE = 20
const STREAM_FLUSH_DELAY_MS = 180

export interface DshRpcRequest {
  rpcId: string
  payload: Record<string, unknown>
}

export interface HostApiProxy {
  sessions: {
    list(request: DshRpcRequest): Promise<unknown>
    create?(request: DshRpcRequest): Promise<unknown>
    rename?(request: DshRpcRequest): Promise<unknown>
    models?(request: DshRpcRequest): Promise<unknown>
    selectModel?(request: DshRpcRequest): Promise<unknown>
    cancel?(request: DshRpcRequest): Promise<unknown>
    prompt(request: DshRpcRequest): Promise<unknown>
  }
  workspace: {
    list(request: DshRpcRequest): Promise<unknown>
    create?(request: DshRpcRequest): Promise<unknown>
  }
  host?: {
    createDirectory?(request: DshRpcRequest): Promise<unknown>
  }
}

export interface SessionEventContext {
  on?(event: string, listener: (...args: any[]) => void): (() => void) | void
  effect(factory: () => void | (() => void | Promise<void>), label?: string): void
  apiProxy?: HostApiProxy
}

interface SessionRow {
  sessionId: string
  updatedAt: number
  blank: boolean
  cwd?: string
  title?: string
}

interface WorkspaceRow {
  workspaceId?: string
  path?: string
  title: string
  sessionIds: string[]
}

interface WorkspaceChoice {
  workspaceId: string
  title: string
  path: string
}

interface MenuEntry {
  sessionId: string
  workspaceTitle: string
  taskTitle: string
}

interface UserState {
  selectedSessionId?: string
  selectedSessionName?: string
  page: number
  entries: MenuEntry[]
  settingsMenu?: 'global' | 'session' | 'model' | 'mode'
  modelOptions: ModelOption[]
  permissionOptions: PermissionOption[]
  creationMenu?: 'root' | 'workspace-parent' | 'workspace-name' | 'task-workspace' | 'task-title'
  creationParentPath?: string
  creationWorkspaces: WorkspaceChoice[]
  creationWorkspace?: WorkspaceChoice
}

interface ModelOption {
  provider: string
  model: string
  label: string
}

interface PermissionOption {
  value: string
  name: string
  description?: string
}

interface SessionStats {
  turns: number
  steps: number
  llmMs: number
  toolMs: number
  ttftMs: number
  ttftSteps: number
  decodeMs: number
  decodeTokens: number
}

interface TokenUsage {
  uncachedInputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
}

interface SessionConfig {
  stats?: SessionStats
  usage?: TokenUsage
  permissions: { currentValue?: string; options: PermissionOption[] }
  model?: { provider: string; model: string; reasoningEffort?: string }
}

export type WechatReply = (senderId: string, text: string, signal: AbortSignal) => Promise<void>
export type WechatTyping = (senderId: string, contextToken: string | undefined, typing: boolean, signal: AbortSignal) => Promise<void>

export class WechatDshSessionRouter {
  private readonly users = new Map<string, UserState>()
  private readonly userQueues = new Map<string, Promise<void>>()
  private readonly subscribers = new Map<string, Map<string, string>>()
  private readonly controller = new AbortController()
  private readonly stepText = new Map<string, string>()
  private readonly stepSentLength = new Map<string, number>()
  private readonly streamTimers = new Map<string, ReturnType<typeof setTimeout>>()

  constructor(
    private readonly api: HostApiProxy,
    private readonly reply: WechatReply,
    private readonly typing?: WechatTyping,
    private readonly settingsStore?: SettingsStore,
  ) {
    this.settingsReady = this.loadSettings()
  }

  private settings: EveryConnectSettings = { ...DEFAULT_EVERYCONNECT_SETTINGS }
  private readonly settingsReady: Promise<void>
  private readonly streamedSteps = new Set<string>()

  async handle(message: InboundMessage, signal: AbortSignal): Promise<void> {
    const senderId = message.senderId
    const previous = this.userQueues.get(senderId) || Promise.resolve()
    const task = previous.catch(() => undefined).then(() => this.handleMessage(message, signal))
    const queued = task.finally(() => {
      if (this.userQueues.get(senderId) === queued) this.userQueues.delete(senderId)
    })
    this.userQueues.set(senderId, queued)
    return queued
  }

  private async handleMessage(message: InboundMessage, signal: AbortSignal): Promise<void> {
    await this.settingsReady
    const senderId = message.senderId
    const text = message.text.trim()
    if (!text) return

    const state = this.stateFor(senderId)
    if (text.startsWith('/')) {
      await this.handleCommand(senderId, text, state, signal)
      return
    }

    if (state.settingsMenu) {
      await this.handleSettingsInput(senderId, text, state, signal)
      return
    }

    if (state.creationMenu) {
      await this.handleCreationInput(senderId, text, state, signal)
      return
    }

    if (!state.selectedSessionId) {
      const selection = Number.parseInt(text, 10)
      if (String(selection) === text && selection > 0 && selection <= state.entries.length) {
        const entry = state.entries[selection - 1]
        this.select(senderId, entry.sessionId, entry.taskTitle)
        await this.sendSessionReply(senderId, state, `已进入 **${entry.workspaceTitle} - ${entry.taskTitle}**\n\n后续消息会同步到此会话。发送 \`/exit\` 或 \`/home\` 返回菜单。\n输入 \`/help\` 获取命令指引。`, signal)
        return
      }
      await this.sendMenu(senderId, state, signal, '请先发送菜单中的编号选择任务会话。')
      return
    }

    try {
      void this.startTyping(senderId, message.replyContext?.contextToken, signal)
      await this.api.sessions.prompt({
        rpcId: randomUUID(),
        payload: {
          sessionId: state.selectedSessionId,
          mode: 'queue',
          content: [{ type: 'text', text: message.text }],
        },
      })
    } catch (error) {
      void this.stopTyping(senderId, signal)
      await this.sendSessionReply(senderId, state, `会话消息发送失败：${formatError(error)}`, signal)
    }
  }

  async handleEvent(session: unknown, event: unknown): Promise<void> {
    await this.settingsReady
    const sessionId = sessionIdOf(session)
    if (!sessionId) return
    const senders = this.subscribers.get(sessionId)
    if (!senders?.size) return

    const record = asRecord(event)
    const data = asRecord(record.data)
    if (record.type === 'assistant/chunk') {
      const chunk = asRecord(data.chunk)
      const text = extractChunkText(chunk)
      if (!text) return
      const stepKey = stepKeyOf(sessionId, data)
      this.streamedSteps.add(stepKey)
      this.appendStepText(stepKey, text)
      if (!this.settings.mergeAssistantInfo) this.scheduleStreamFlush(stepKey, senders)
      return
    }
    if (record.type !== 'assistant/message') return

    const stepKey = stepKeyOf(sessionId, data)
    this.cancelStreamFlush(stepKey)
    const bufferedText = this.stepText.get(stepKey) || ''
    this.stepText.delete(stepKey)
    const finalText = extractMessageText(asRecord(data.message)) || bufferedText
    const wasStreamed = this.streamedSteps.delete(stepKey)
    if (!finalText) {
      this.stepSentLength.delete(stepKey)
      return
    }
    if (!this.settings.mergeAssistantInfo && wasStreamed) {
      const sentLength = this.stepSentLength.get(stepKey) || 0
      this.stepSentLength.delete(stepKey)
      const remainder = finalText.slice(sentLength)
      if (remainder) await this.sendAssistantText(senders, remainder)
      return
    }
    this.stepSentLength.delete(stepKey)
    await this.sendAssistantText(senders, formatWechatMarkdown(finalText))
  }

  dispose(): void {
    this.controller.abort()
    this.users.clear()
    this.userQueues.clear()
    this.subscribers.clear()
    this.stepText.clear()
    this.stepSentLength.clear()
    for (const timer of this.streamTimers.values()) clearTimeout(timer)
    this.streamTimers.clear()
    this.streamedSteps.clear()
  }

  private async handleCommand(senderId: string, text: string, state: UserState, signal: AbortSignal): Promise<void> {
    const parts = text.trim().split(/\s+/)
    const command = parts[0].toLowerCase()
    if (command === '/exit' || command === '/home') {
      void this.stopTyping(senderId, signal)
      this.clearSelection(senderId)
      state.settingsMenu = undefined
      this.resetCreation(state)
      state.page = 0
      await this.sendMenu(senderId, state, signal)
      return
    }
    if (command === '/setting' || command === '/settings') {
      state.settingsMenu = state.selectedSessionId ? 'session' : 'global'
      await this.sendSettings(senderId, state, signal)
      return
    }
    if (command === '/config') {
      state.settingsMenu = undefined
      await this.sendConfig(senderId, state, signal)
      return
    }
    if (command === '/help') {
      await this.sendHelp(senderId, state, signal)
      return
    }
    if (command === '/new') {
      await this.startCreation(senderId, parts[1]?.toLowerCase(), state, signal)
      return
    }
    if (command === '/stop') {
      await this.stopSession(senderId, state, signal)
      return
    }
    if (command === '/back' || command === '/chat') {
      state.settingsMenu = undefined
      this.resetCreation(state)
      if (state.selectedSessionId) await this.sendSessionReply(senderId, state, '已返回当前会话。', signal)
      else await this.sendMenu(senderId, state, signal)
      return
    }
    if (command === '/next') {
      state.page += 1
      await this.sendMenu(senderId, state, signal)
      return
    }
    if (command === '/prev' || command === '/previous') {
      state.page = Math.max(0, state.page - 1)
      await this.sendMenu(senderId, state, signal)
      return
    }

    state.page = 0
    state.settingsMenu = undefined
    this.resetCreation(state)
    await this.sendMenu(senderId, state, signal)
  }

  private async startCreation(senderId: string, kind: string | undefined, state: UserState, signal: AbortSignal): Promise<void> {
    if (!kind) {
      state.creationMenu = 'root'
      await this.sendCreation(senderId, state, signal)
      return
    }
    if (kind === 'workspace' || kind === 'directory' || kind === 'folder') {
      state.creationMenu = 'workspace-parent'
      await this.sendCreation(senderId, state, signal)
      return
    }
    if (kind === 'task' || kind === 'session') {
      await this.startTaskCreation(senderId, state, signal)
      return
    }
    await this.send(senderId, '用法：发送 `/new` 查看新建菜单，或发送 `/new workspace`、`/new task`。', signal)
  }

  private async startTaskCreation(senderId: string, state: UserState, signal: AbortSignal): Promise<void> {
    if (!this.api.sessions.create) {
      await this.send(senderId, '当前 Host 不支持新建任务。', signal)
      return
    }
    try {
      state.creationWorkspaces = await this.loadWorkspaceChoices()
      state.creationMenu = 'task-workspace'
      await this.sendCreation(senderId, state, signal)
    } catch (error) {
      await this.send(senderId, `读取工作目录失败：${formatError(error)}`, signal)
    }
  }

  private async sendCreation(senderId: string, state: UserState, signal: AbortSignal, notice?: string): Promise<void> {
    const lines: string[] = []
    if (state.creationMenu === 'root') {
      lines.push('**新建**', '')
      if (notice) lines.push(notice, '')
      lines.push('1. 新建工作目录', '2. 新建任务', '', '发送编号选择，发送 `/back` 取消。')
    } else if (state.creationMenu === 'workspace-parent') {
      lines.push('**新建工作目录**', '', '请发送父目录路径，例如 `E:/workspace`。', '下一步再输入新目录名称。', '', '发送 `/back` 取消。')
    } else if (state.creationMenu === 'workspace-name') {
      lines.push('**新建工作目录**', '', `父目录：\`${inlineCode(state.creationParentPath || '')}\``, '请发送新目录名称。名称不能包含 `/` 或 `\\`。', '', '发送 `/back` 取消。')
    } else if (state.creationMenu === 'task-workspace') {
      lines.push('**新建任务**', '', notice || '请选择任务所属的工作目录。')
      if (state.creationWorkspaces.length === 0) {
        lines.push('', '当前没有已登记的工作目录，请先发送 `/new workspace`。')
      } else {
        state.creationWorkspaces.forEach((workspace, index) => lines.push(`${index + 1}. ${workspace.title} \`${inlineCode(workspace.path)}\``))
        lines.push('', '发送编号选择工作目录，发送 `/back` 取消。')
      }
    } else if (state.creationMenu === 'task-title') {
      lines.push('**新建任务**', '', `工作目录：**${state.creationWorkspace?.title || ''}**`, '请发送任务名称。', '任务名称会显示在会话菜单中。', '', '发送 `/back` 取消。')
    }
    const text = lines.join('\n')
    if (state.selectedSessionId) await this.sendSessionReply(senderId, state, text, signal)
    else await this.send(senderId, text, signal)
  }

  private async handleCreationInput(senderId: string, text: string, state: UserState, signal: AbortSignal): Promise<void> {
    if (state.creationMenu === 'root') {
      if (text === '1') {
        state.creationMenu = 'workspace-parent'
        await this.sendCreation(senderId, state, signal)
        return
      }
      if (text === '2') {
        await this.startTaskCreation(senderId, state, signal)
        return
      }
      await this.sendCreation(senderId, state, signal, '请发送 `1` 新建工作目录，或发送 `2` 新建任务。')
      return
    }

    if (state.creationMenu === 'workspace-parent') {
      if (!text || text.includes('\n') || text.includes('\r')) {
        await this.sendCreation(senderId, state, signal, '父目录路径不能为空。')
        return
      }
      state.creationParentPath = text
      state.creationMenu = 'workspace-name'
      await this.sendCreation(senderId, state, signal)
      return
    }

    if (state.creationMenu === 'workspace-name') {
      if (!state.creationParentPath || !isDirectoryName(text)) {
        await this.sendCreation(senderId, state, signal, '目录名称不能为空，且不能包含 `/` 或 `\\`。')
        return
      }
      if (!this.api.host?.createDirectory || !this.api.workspace.create) {
        await this.sendCreation(senderId, state, signal, '当前 Host 未提供新建工作目录接口。')
        return
      }
      try {
        const directory = asRecord(await callApi(this.api.host.createDirectory, { path: state.creationParentPath, name: text }))
        const path = isString(directory.path) ? directory.path : ''
        if (!path) throw new Error('Host 未返回新目录路径')
        const workspace = asRecord(await callApi(this.api.workspace.create, { path }))
        const created = asRecord(workspace.workspace)
        this.resetCreation(state)
        await this.send(senderId, `已新建工作目录：**${isString(created.title) ? created.title : text}**\n路径：\`${inlineCode(path)}\``, signal)
        await this.sendMenu(senderId, state, signal)
      } catch (error) {
        await this.sendCreation(senderId, state, signal, `新建工作目录失败：${formatError(error)}`)
      }
      return
    }

    if (state.creationMenu === 'task-workspace') {
      const selection = Number.parseInt(text, 10)
      const workspace = String(selection) === text ? state.creationWorkspaces[selection - 1] : undefined
      if (!workspace) {
        await this.sendCreation(senderId, state, signal, '请发送工作目录列表中的编号。')
        return
      }
      state.creationWorkspace = workspace
      state.creationMenu = 'task-title'
      await this.sendCreation(senderId, state, signal)
      return
    }

    if (state.creationMenu === 'task-title') {
      const workspace = state.creationWorkspace
      if (!workspace || !this.api.sessions.create || !text.trim()) {
        await this.sendCreation(senderId, state, signal, '任务名称不能为空。')
        return
      }
      try {
        const created = asRecord(await callApi(this.api.sessions.create, { workspaceId: workspace.workspaceId }))
        const sessionId = isString(created.sessionId) ? created.sessionId : ''
        if (!sessionId) throw new Error('Host 未返回新任务 ID')
        if (this.api.sessions.rename) await callApi(this.api.sessions.rename, { sessionId, title: text.trim() })
        this.resetCreation(state)
        this.select(senderId, sessionId, text.trim())
        await this.sendSessionReply(senderId, state, `已新建任务：**${text.trim()}**\n工作目录：**${workspace.title}**\n\n后续消息会同步到此任务。\n输入 \`/help\` 获取命令指引。`, signal)
      } catch (error) {
        await this.sendCreation(senderId, state, signal, `新建任务失败：${formatError(error)}`)
      }
    }
  }

  private async loadWorkspaceChoices(): Promise<WorkspaceChoice[]> {
    const value = asRecord(await callApi(this.api.workspace.list, {}))
    const items = Array.isArray(value.items) ? value.items : []
    return items.map(asRecord).filter((item: Record<string, unknown>) => isString(item.workspaceId) && isString(item.path)).map((item) => ({
      workspaceId: item.workspaceId as string,
      title: isString(item.title) ? item.title : String(item.path),
      path: item.path as string,
    }))
  }

  private resetCreation(state: UserState): void {
    state.creationMenu = undefined
    state.creationParentPath = undefined
    state.creationWorkspace = undefined
    state.creationWorkspaces = []
  }

  private async sendMenu(senderId: string, state: UserState, signal: AbortSignal, notice?: string): Promise<void> {
    try {
      state.entries = await this.loadEntries()
      const pageCount = Math.max(1, Math.ceil(state.entries.length / PAGE_SIZE))
      state.page = Math.min(state.page, pageCount - 1)
      const start = state.page * PAGE_SIZE
      const entries = state.entries.slice(start, start + PAGE_SIZE)
      const lines = ['**工作区-任务会话**', '']
      if (notice) lines.push(notice, '')
      if (entries.length === 0) {
        lines.push('当前没有可用的任务会话。')
      } else {
        let currentWorkspace = ''
        entries.forEach((entry, index) => {
          if (entry.workspaceTitle !== currentWorkspace) {
            if (currentWorkspace) lines.push('')
            lines.push(`**${entry.workspaceTitle}**`)
            currentWorkspace = entry.workspaceTitle
          }
          lines.push(`${start + index + 1}. ${entry.taskTitle} \`${entry.sessionId}\``)
        })
        lines.push('', '发送编号进入会话。')
      }
      if (pageCount > 1) lines.push(`第 ${state.page + 1}/${pageCount} 页：发送 \`/next\` 或 \`/prev\` 翻页。`)
      lines.push('')
      appendCommandHints(lines)
      await this.send(senderId, lines.join('\n'), signal)
    } catch (error) {
      await this.send(senderId, `读取任务会话失败：${formatError(error)}`, signal)
    }
  }

  private async sendHelp(senderId: string, state: UserState, signal: AbortSignal): Promise<void> {
    const lines = ['**命令指引**', '']
    appendCommandHints(lines)
    if (state.selectedSessionId) {
      await this.sendSessionReply(senderId, state, lines.join('\n'), signal)
      return
    }
    await this.send(senderId, lines.join('\n'), signal)
  }

  private async sendSettings(senderId: string, state: UserState, signal: AbortSignal, notice?: string): Promise<void> {
    if (state.settingsMenu === 'global') {
      const lines = ['**整体设置**', '']
      if (notice) lines.push(notice, '')
      lines.push(`1. 合并发送 Assistant 信息：${this.settings.mergeAssistantInfo ? '开启' : '关闭'}`)
      lines.push('', '发送 `1` 切换。发送 `/back` 返回菜单。')
      await this.send(senderId, lines.join('\n'), signal)
      return
    }

    if (state.settingsMenu === 'model') {
      const lines = ['**选择模型**', '']
      if (notice) lines.push(notice, '')
      if (state.modelOptions.length === 0) lines.push('当前没有可用模型。')
      else state.modelOptions.forEach((option, index) => lines.push(`${index + 1}. ${option.label}`))
      lines.push('', '发送编号选择模型，发送 `/setting` 返回会话设置；发送 `/back` 返回聊天。')
      await this.sendSessionReply(senderId, state, lines.join('\n'), signal)
      return
    }

    if (state.settingsMenu === 'mode') {
      const lines = ['**模型模式**', '']
      if (notice) lines.push(notice, '')
      if (state.permissionOptions.length === 0) lines.push('当前 Host 没有提供可切换的模式。')
      else state.permissionOptions.forEach((option, index) => lines.push(`${index + 1}. ${permissionLabel(option)}${option.description ? `：${option.description}` : ''}`))
      lines.push('', '发送编号切换模式，发送 `/setting` 返回会话设置；发送 `/back` 返回聊天。')
      await this.sendSessionReply(senderId, state, lines.join('\n'), signal)
      return
    }

    let model: { provider: string; model: string } | undefined
    try {
      model = await this.loadCurrentModel(state.selectedSessionId, signal)
    } catch (error) {
      console.error(`[everyconnect] model load failed: ${formatError(error)}`)
    }
    const permission = await this.loadPermissions(state.selectedSessionId, signal)
    state.permissionOptions = permission.options
    const lines = ['**会话设置**', '']
    if (notice) lines.push(notice, '')
    lines.push(`1. 模型：${model ? `${model.provider}/${model.model}` : '读取失败'}`)
    lines.push(`2. 模型模式：${permission.currentValue ? permissionLabel({ value: permission.currentValue, name: permission.currentValue }) : '读取失败'}`)
    lines.push('', '发送 `1` 设置模型，发送 `2` 设置模型模式；发送 `/back` 返回聊天。')
    await this.sendSessionReply(senderId, state, lines.join('\n'), signal)
  }

  private async sendConfig(senderId: string, state: UserState, signal: AbortSignal): Promise<void> {
    if (!state.selectedSessionId) {
      await this.send(senderId, '请先从工作区-任务会话菜单中选择一个会话，再发送 `/config`。', signal)
      return
    }

    try {
      const config = await this.loadSessionConfig(state.selectedSessionId, signal)
      const lines = ['**当前会话配置**', '']
      lines.push(`模型：${config.model ? formatModel(config.model) : '暂无数据'}`)
      lines.push(`模型模式：${config.permissions.currentValue ? permissionLabel({ value: config.permissions.currentValue, name: config.permissions.currentValue }) : '暂无数据'}`)
      lines.push('')
      lines.push(`统计：${config.stats ? `${config.stats.turns} 轮 · ${config.stats.steps} 步` : '暂无数据'}`)
      if (config.stats) {
        const durations = [
          `模型 ${formatDuration(config.stats.llmMs)}`,
          `工具 ${formatDuration(config.stats.toolMs)}`,
        ]
        if (config.stats.ttftSteps > 0) durations.push(`首 token ${formatDuration(config.stats.ttftMs / config.stats.ttftSteps)}`)
        if (config.stats.decodeMs > 0 && config.stats.decodeTokens > 0) {
          durations.push(`解码 ${formatDuration(config.stats.decodeMs)}`)
          durations.push(`${formatNumber(config.stats.decodeTokens / (config.stats.decodeMs / 1000))} token/s`)
        }
        lines.push(`时间分布：${durations.join(' · ')}`)
      } else {
        lines.push('时间分布：暂无数据')
      }
      lines.push(formatUsageLine(config.usage))
      lines.push('', '发送 `/setting` 修改模型或模型模式，发送 `/back` 返回聊天。')
      await this.sendSessionReply(senderId, state, lines.join('\n'), signal)
    } catch (error) {
      await this.sendSessionReply(senderId, state, `读取会话配置失败：${formatError(error)}`, signal)
    }
  }

  private async stopSession(senderId: string, state: UserState, signal: AbortSignal): Promise<void> {
    if (!state.selectedSessionId) {
      await this.send(senderId, '请先进入一个会话，再发送 `/stop`。', signal)
      return
    }
    if (!this.api.sessions.cancel) {
      await this.sendSessionReply(senderId, state, '当前 Host 不支持暂停任务。', signal)
      return
    }
    void this.stopTyping(senderId, signal)
    try {
      await callApi(this.api.sessions.cancel, { sessionId: state.selectedSessionId })
      await this.sendSessionReply(senderId, state, '已请求暂停当前任务。', signal)
    } catch (error) {
      await this.sendSessionReply(senderId, state, `暂停任务失败：${formatError(error)}`, signal)
    }
  }

  private async handleSettingsInput(senderId: string, text: string, state: UserState, signal: AbortSignal): Promise<void> {
    const selection = Number.parseInt(text, 10)
    if (String(selection) !== text || selection < 1) {
      await this.sendSettings(senderId, state, signal, '请发送设置菜单中的编号。')
      return
    }

    if (state.settingsMenu === 'global') {
      if (selection !== 1) {
        await this.sendSettings(senderId, state, signal, '没有这个设置编号。')
        return
      }
      this.settings = { ...this.settings, mergeAssistantInfo: !this.settings.mergeAssistantInfo }
      try {
        await this.settingsStore?.save(this.settings, signal)
      } catch (error) {
        await this.sendSettings(senderId, state, signal, `保存整体设置失败：${formatError(error)}`)
        return
      }
      await this.sendSettings(senderId, state, signal, '整体设置已更新。')
      return
    }

    if (state.settingsMenu === 'session') {
      if (selection === 1) {
        state.settingsMenu = 'model'
        try {
          state.modelOptions = await this.loadModelOptions(state.selectedSessionId, signal)
        } catch (error) {
          await this.sendSettings(senderId, state, signal, `读取模型失败：${formatError(error)}`)
          return
        }
        await this.sendSettings(senderId, state, signal)
        return
      }
      if (selection === 2) {
        state.settingsMenu = 'mode'
        await this.sendSettings(senderId, state, signal)
        return
      }
      await this.sendSettings(senderId, state, signal, '没有这个设置编号。')
      return
    }

    if (state.settingsMenu === 'model') {
      const option = state.modelOptions[selection - 1]
      if (!option || !state.selectedSessionId || !this.api.sessions.selectModel) {
        await this.sendSettings(senderId, state, signal, '没有这个模型编号，或当前 Host 不支持模型切换。')
        return
      }
      try {
        await callApi(this.api.sessions.selectModel, {
          sessionId: state.selectedSessionId,
          provider: option.provider,
          model: option.model,
        })
        state.settingsMenu = 'session'
        await this.sendSettings(senderId, state, signal, `模型已切换为 ${option.label}。`)
      } catch (error) {
        await this.sendSettings(senderId, state, signal, `切换模型失败：${formatError(error)}`)
      }
      return
    }

    if (state.settingsMenu === 'mode') {
      const option = state.permissionOptions[selection - 1]
      if (!option || !state.selectedSessionId) {
        await this.sendSettings(senderId, state, signal, '没有这个模式编号。')
        return
      }
      try {
        await callApi(this.api.sessions.prompt, {
          sessionId: state.selectedSessionId,
          mode: 'queue',
          content: [{ type: 'text', text: `/permission ${option.value}` }],
        })
        state.settingsMenu = 'session'
        await this.sendSettings(senderId, state, signal, `模型模式已切换为 ${permissionLabel(option)}。`)
      } catch (error) {
        await this.sendSettings(senderId, state, signal, `切换模型模式失败：${formatError(error)}`)
      }
    }
  }

  private async loadEntries(): Promise<MenuEntry[]> {
    const [workspaceValue, sessionValue] = await Promise.all([
      callApi(this.api.workspace.list, {}),
      callApi(this.api.sessions.list, {}),
    ])
    const rawSessionItems: unknown[] = Array.isArray(asRecord(sessionValue).items) ? asRecord(sessionValue).items : []
    const sessionRows: SessionRow[] = rawSessionItems
      .map(toSessionRow)
      .filter((row: SessionRow | undefined): row is SessionRow => row !== undefined && !row.blank)
    const sessions = new Map(sessionRows.map((row) => [row.sessionId, row]))
    const workspacePayload = asRecord(workspaceValue)
    const archived = new Set(Array.isArray(workspacePayload.archivedSessionIds) ? workspacePayload.archivedSessionIds.filter(isString) : [])
    const rawWorkspaceItems: unknown[] = Array.isArray(workspacePayload.items) ? workspacePayload.items : []
    const workspaces: WorkspaceRow[] = rawWorkspaceItems.map(toWorkspaceRow)
    const entries: MenuEntry[] = []
    const grouped = new Set<string>()

    for (const workspace of workspaces) {
      for (const sessionId of workspace.sessionIds) {
        const row = sessions.get(sessionId)
        if (!row || archived.has(sessionId)) continue
        grouped.add(sessionId)
        entries.push({ sessionId, workspaceTitle: workspace.title, taskTitle: taskTitle(row) })
      }
    }
    for (const row of sessionRows) {
      if (grouped.has(row.sessionId) || archived.has(row.sessionId)) continue
      entries.push({ sessionId: row.sessionId, workspaceTitle: '未归档工作区', taskTitle: taskTitle(row) })
    }
    return entries
  }

  private async loadSettings(): Promise<void> {
    if (!this.settingsStore) return
    try {
      this.settings = await this.settingsStore.load(this.controller.signal)
    } catch (error) {
      console.error(`[everyconnect] settings load failed, using defaults: ${formatError(error)}`)
    }
  }

  private async loadCurrentModel(sessionId: string | undefined, signal: AbortSignal): Promise<{ provider: string; model: string } | undefined> {
    if (!sessionId || !this.api.sessions.models) return undefined
    const value = asRecord(await callApi(this.api.sessions.models, { sessionId }))
    const current = asRecord(value.current)
    return isString(current.provider) && isString(current.model) ? { provider: current.provider, model: current.model } : undefined
  }

  private async loadModelOptions(sessionId: string | undefined, signal: AbortSignal): Promise<ModelOption[]> {
    if (!sessionId || !this.api.sessions.models) return []
    const value = asRecord(await callApi(this.api.sessions.models, { sessionId }))
    const groups = Array.isArray(value.groups) ? value.groups : []
    const options: ModelOption[] = []
    for (const groupValue of groups) {
      const group = asRecord(groupValue)
      const provider = isString(group.id) ? group.id : ''
      const providerName = isString(group.name) ? group.name : provider
      const models = Array.isArray(group.models) ? group.models : []
      for (const modelValue of models) {
        const model = asRecord(modelValue)
        if (!provider || !isString(model.id)) continue
        options.push({
          provider,
          model: model.id,
          label: `${providerName} / ${isString(model.name) ? model.name : model.id}`,
        })
      }
    }
    return options
  }

  private async loadPermissions(sessionId: string | undefined, signal: AbortSignal): Promise<{ currentValue?: string; options: PermissionOption[] }> {
    if (!sessionId) return { options: [] }
    try {
      const value = asRecord(await callApi(this.api.sessions.list, {}))
      const rows = Array.isArray(value.items) ? value.items : []
      const row = rows.map(asRecord).find((item: Record<string, any>) => item.sessionId === sessionId)
      const projections = asRecord(asRecord(row).projections)
      const values = asRecord(projections.values)
      const permissions = asRecord(values.permissions)
      const options = Array.isArray(permissions.options) ? permissions.options.map(toPermissionOption).filter((option): option is PermissionOption => option !== undefined) : []
      return {
        currentValue: isString(permissions.currentValue) ? permissions.currentValue : undefined,
        options: options.length ? options : fallbackPermissionOptions(),
      }
    } catch (error) {
      console.error(`[everyconnect] permissions load failed: ${formatError(error)}`)
      return { options: fallbackPermissionOptions() }
    }
  }

  private async loadSessionConfig(sessionId: string, signal: AbortSignal): Promise<SessionConfig> {
    const [sessionValue, modelValue] = await Promise.all([
      callApi(this.api.sessions.list, {}),
      this.api.sessions.models ? callApi(this.api.sessions.models, { sessionId }) : Promise.resolve(undefined),
    ])
    const rows = Array.isArray(asRecord(sessionValue).items) ? asRecord(sessionValue).items : []
    const row = rows.map(asRecord).find((item: Record<string, any>) => item.sessionId === sessionId)
    const values = asRecord(asRecord(asRecord(row).projections).values)
    const stats = toSessionStats(values.sessionStats)
    const usage = toTokenUsage(values.tokenUsage)
    const permissions = toPermissionSelect(values.permissions)
    const current = asRecord(asRecord(modelValue).current)
    const model = isString(current.provider) && isString(current.model)
      ? { provider: current.provider, model: current.model, ...(isString(current.reasoningEffort) ? { reasoningEffort: current.reasoningEffort } : {}) }
      : undefined
    return { stats, usage, permissions, model }
  }

  private stateFor(senderId: string): UserState {
    let state = this.users.get(senderId)
    if (!state) {
      state = { page: 0, entries: [], modelOptions: [], permissionOptions: [], creationWorkspaces: [] }
      this.users.set(senderId, state)
    }
    return state
  }

  private select(senderId: string, sessionId: string, sessionName: string): void {
    const state = this.stateFor(senderId)
    if (state.selectedSessionId) this.unsubscribe(senderId, state.selectedSessionId)
    state.selectedSessionId = sessionId
    state.selectedSessionName = sessionName
    let senders = this.subscribers.get(sessionId)
    if (!senders) {
      senders = new Map()
      this.subscribers.set(sessionId, senders)
    }
    senders.set(senderId, sessionName)
  }

  private clearSelection(senderId: string): void {
    const state = this.stateFor(senderId)
    if (state.selectedSessionId) this.unsubscribe(senderId, state.selectedSessionId)
    state.selectedSessionId = undefined
    state.selectedSessionName = undefined
  }

  private unsubscribe(senderId: string, sessionId: string): void {
    const senders = this.subscribers.get(sessionId)
    senders?.delete(senderId)
    if (senders && senders.size === 0) this.subscribers.delete(sessionId)
  }

  private async send(senderId: string, text: string, signal: AbortSignal): Promise<void> {
    if (!text.trim() || signal.aborted) return
    try {
      await this.reply(senderId, text, signal)
    } catch (error) {
      console.error(`[everyconnect] WeChat reply failed: ${formatError(error)}`)
    }
  }

  private async sendSessionReply(senderId: string, state: UserState, text: string, signal: AbortSignal): Promise<void> {
    const sessionName = state.selectedSessionName
    await this.send(senderId, sessionName ? `\`${inlineCode(sessionName)}\`\n${text}` : text, signal)
  }

  private appendStepText(stepKey: string, text: string): void {
    this.stepText.set(stepKey, `${this.stepText.get(stepKey) || ''}${text}`)
  }

  private scheduleStreamFlush(stepKey: string, senders: Map<string, string>): void {
    const previous = this.streamTimers.get(stepKey)
    if (previous) clearTimeout(previous)
    const timer = setTimeout(() => {
      this.streamTimers.delete(stepKey)
      void this.flushStreamStep(stepKey, senders)
    }, STREAM_FLUSH_DELAY_MS)
    this.streamTimers.set(stepKey, timer)
  }

  private cancelStreamFlush(stepKey: string): void {
    const timer = this.streamTimers.get(stepKey)
    if (timer) clearTimeout(timer)
    this.streamTimers.delete(stepKey)
  }

  private async flushStreamStep(stepKey: string, senders: Map<string, string>): Promise<void> {
    const accumulated = this.stepText.get(stepKey) || ''
    const sentLength = this.stepSentLength.get(stepKey) || 0
    const delta = accumulated.slice(sentLength)
    if (!delta) return
    await this.sendAssistantText(senders, delta)
    this.stepSentLength.set(stepKey, accumulated.length)
  }

  private async sendAssistantText(senders: Map<string, string>, text: string): Promise<void> {
    const formatted = formatWechatMarkdown(text)
    if (!formatted) return
    await Promise.all([...senders].map(async ([senderId, sessionName]) => {
      void this.stopTyping(senderId, this.controller.signal)
      await this.send(senderId, `\`${inlineCode(sessionName)}\`\n${formatted}`, this.controller.signal)
    }))
  }

  private async startTyping(senderId: string, contextToken: string | undefined, signal: AbortSignal): Promise<void> {
    if (!this.typing) return
    try {
      await this.typing(senderId, contextToken, true, signal)
    } catch (error) {
      console.error(`[everyconnect] WeChat typing start failed: ${formatError(error)}`)
    }
  }

  private async stopTyping(senderId: string, signal: AbortSignal): Promise<void> {
    if (!this.typing) return
    try {
      await this.typing(senderId, undefined, false, signal)
    } catch (error) {
      console.error(`[everyconnect] WeChat typing stop failed: ${formatError(error)}`)
    }
  }
}

export function bindWechatDshSessionRouter(
  ctx: { inject?(services: string[], callback: (...services: unknown[]) => void): void },
  adapter: PlatformAdapter,
  settingsStore?: SettingsStore,
  onReady?: (router: WechatDshSessionRouter) => void,
): void {
  ctx.inject?.(['apiProxy'], (apiProxy) => {
    const scope = apiProxy as SessionEventContext
    if (!scope.apiProxy && !isHostApiProxy(apiProxy)) return
    const api = (scope.apiProxy || apiProxy) as HostApiProxy
    const router = new WechatDshSessionRouter(api, async (senderId, text, signal) => {
      await adapter.send({ platform: 'wechat-claw', conversationId: senderId, text }, signal)
    }, async (senderId, contextToken, typing, signal) => {
      await adapter.setTyping?.(senderId, contextToken, typing, signal)
    }, settingsStore)
    onReady?.(router)
    const dispose = scope.on?.('session/event', (...args) => {
      void router.handleEvent(args[0], args[1])
    })
    scope.effect(() => {
      return () => {
        if (typeof dispose === 'function') dispose()
        router.dispose()
      }
    }, 'everyconnect: WeChat DSH session router')
  })
}

export function formatWechatMarkdown(input: string): string {
  return input
    .replace(/```[^\n]*\n([\s\S]*?)```/g, (_match, body: string) => body.trimEnd().split('\n').map((line) => `\`${line}\``).join('\n'))
    .replace(/\[([^\]]+)\]\([^\)]+\)/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s*>\s?/gm, '')
}

function callApi(method: (request: DshRpcRequest) => Promise<unknown>, payload: Record<string, unknown>): Promise<unknown> {
  return method({ rpcId: randomUUID(), payload }).then(unwrapRpc)
}

function unwrapRpc(response: unknown): unknown {
  const record = asRecord(response)
  const result = asRecord(record.result)
  if (result.ok === false) throw new Error(errorMessage(result.error))
  if (result.ok === true) return result.value
  if (record.ok === false) throw new Error(errorMessage(record.error))
  return 'value' in record ? record.value : response
}

function errorMessage(value: unknown): string {
  const error = asRecord(value)
  return typeof error.message === 'string' ? error.message : typeof value === 'string' ? value : 'Host API error'
}

function toSessionRow(value: unknown): SessionRow | undefined {
  const row = asRecord(value)
  if (!isString(row.sessionId)) return undefined
  const projections = asRecord(row.projections)
  const projectionValues = asRecord(projections.values)
  const title = isString(row.title) ? row.title : isString(projectionValues.title) ? projectionValues.title : undefined
  return {
    sessionId: row.sessionId,
    updatedAt: typeof row.updatedAt === 'number' ? row.updatedAt : 0,
    blank: row.blank === true,
    ...(isString(row.cwd) ? { cwd: row.cwd } : {}),
    ...(title ? { title } : {}),
  }
}

function toWorkspaceRow(value: unknown): WorkspaceRow {
  const row = asRecord(value)
  return {
    ...(isString(row.workspaceId) ? { workspaceId: row.workspaceId } : {}),
    ...(isString(row.path) ? { path: row.path } : {}),
    title: isString(row.title) && row.title.trim() ? row.title : '未命名工作区',
    sessionIds: Array.isArray(row.sessionIds) ? row.sessionIds.filter(isString) : [],
  }
}

function taskTitle(row: SessionRow): string {
  if (row.title?.trim()) return firstLine(row.title)
  if (row.cwd?.trim()) return firstLine(row.cwd.replaceAll('\\', '/').split('/').at(-1) || row.cwd)
  return row.sessionId
}

function firstLine(value: string): string {
  return value.split(/\r?\n/, 1)[0].trim() || value
}

function extractMessageText(message: Record<string, unknown>): string {
  const content = Array.isArray(message.content) ? message.content : []
  return content.map((block) => {
    const record = asRecord(block)
    return record.type === 'text' && isString(record.text) ? record.text : ''
  }).filter(Boolean).join('')
}

function extractChunkText(chunk: Record<string, unknown>): string {
  return (chunk.type === 'text-delta' || chunk.type === 'reasoning-delta') && isString(chunk.text) ? chunk.text : ''
}

function stepKeyOf(sessionId: string, data: Record<string, unknown>): string {
  const turn = typeof data.turn === 'number' || typeof data.turn === 'string' ? String(data.turn) : '0'
  const step = typeof data.step === 'number' || typeof data.step === 'string' ? String(data.step) : '0'
  return `${sessionId}:${turn}:${step}`
}

function toPermissionOption(value: unknown): PermissionOption | undefined {
  const option = asRecord(value)
  if (!isString(option.value)) return undefined
  return {
    value: option.value,
    name: isString(option.name) ? option.name : option.value,
    ...(isString(option.description) ? { description: option.description } : {}),
  }
}

function fallbackPermissionOptions(): PermissionOption[] {
  return [
    { value: 'workspace-write', name: 'workspace-write' },
    { value: 'danger-full-access', name: 'danger-full-access' },
  ]
}

function permissionLabel(option: PermissionOption): string {
  if (option.value === 'danger-full-access') return '完全访问'
  if (option.value === 'workspace-write') return '工作区可写'
  if (option.value === 'read-only') return '只读'
  return option.name
}

function appendCommandHints(lines: string[]): void {
  lines.push(
    '**命令提示**',
    '`/help` 查看命令指引。',
    '`/setting` 打开整体设置；进入会话后打开会话设置。',
    '`/config` 查看当前会话信息（会话中可用）。',
    '`/stop` 暂停当前会话任务（会话中可用）。',
    '`/new` 新建菜单；`/new workspace` 新建工作目录；`/new task` 新建任务。',
    '`/next`、`/prev` 翻页。',
    '`/back`、`/chat` 返回聊天。',
    '`/exit`、`/home` 退出当前会话并返回首页。',
  )
}

function isDirectoryName(value: string): boolean {
  return value.trim().length > 0 && value.length <= 120 && !/[\\/]/.test(value) && !/[\r\n]/.test(value)
}

function toSessionStats(value: unknown): SessionStats | undefined {
  const stats = asRecord(value)
  if (!hasNumber(stats.turns) || !hasNumber(stats.steps)) return undefined
  return {
    turns: stats.turns,
    steps: stats.steps,
    llmMs: numberOrZero(stats.llmMs),
    toolMs: numberOrZero(stats.toolMs),
    ttftMs: numberOrZero(stats.ttftMs),
    ttftSteps: numberOrZero(stats.ttftSteps),
    decodeMs: numberOrZero(stats.decodeMs),
    decodeTokens: numberOrZero(stats.decodeTokens),
  }
}

function toTokenUsage(value: unknown): TokenUsage | undefined {
  const usage = asRecord(value)
  if (!hasNumber(usage.uncachedInputTokens) || !hasNumber(usage.outputTokens)) return undefined
  return {
    uncachedInputTokens: usage.uncachedInputTokens,
    outputTokens: usage.outputTokens,
    cacheReadTokens: numberOrZero(usage.cacheReadTokens),
    cacheWriteTokens: numberOrZero(usage.cacheWriteTokens),
  }
}

function toPermissionSelect(value: unknown): { currentValue?: string; options: PermissionOption[] } {
  const permissions = asRecord(value)
  const options = Array.isArray(permissions.options) ? permissions.options.map(toPermissionOption).filter((option): option is PermissionOption => option !== undefined) : []
  return {
    currentValue: isString(permissions.currentValue) ? permissions.currentValue : undefined,
    options,
  }
}

function formatModel(model: { provider: string; model: string; reasoningEffort?: string }): string {
  return `${model.provider}/${model.model}${model.reasoningEffort ? `（推理：${model.reasoningEffort}）` : ''}`
}

function formatUsageLine(usage: TokenUsage | undefined): string {
  if (!usage) return '缓存命中：暂无数据 · 输入/输出：暂无数据'
  const billedInput = usage.uncachedInputTokens + usage.cacheReadTokens + usage.cacheWriteTokens
  const cacheHit = billedInput > 0 ? `${Math.round(usage.cacheReadTokens / billedInput * 100)}%` : '暂无数据'
  return `缓存命中：${cacheHit} · 输入 ${formatTokens(billedInput)} · 输出 ${formatTokens(usage.outputTokens)}`
}

function formatDuration(ms: number): string {
  if (ms <= 0) return '0s'
  const seconds = ms / 1000
  if (seconds < 60) return `${formatNumber(seconds)}s`
  const rounded = Math.round(seconds)
  return `${Math.floor(rounded / 60)}m${rounded % 60}s`
}

function formatTokens(value: number): string {
  if (value < 1000) return String(Math.round(value))
  if (value < 1000000) return `${formatNumber(value / 1000)}K`
  return `${formatNumber(value / 1000000)}M`
}

function formatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1)
}

function hasNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function numberOrZero(value: unknown): number {
  return hasNumber(value) ? value : 0
}

function sessionIdOf(value: unknown): string {
  const record = asRecord(value)
  return isString(record.id) ? record.id : isString(record.sessionId) ? record.sessionId : ''
}

function isHostApiProxy(value: unknown): value is HostApiProxy {
  const record = asRecord(value)
  return Boolean(asRecord(record.sessions).list && asRecord(record.sessions).prompt && asRecord(record.workspace).list)
}

function isString(value: unknown): value is string {
  return typeof value === 'string'
}

function asRecord(value: unknown): Record<string, any> {
  return typeof value === 'object' && value !== null ? value as Record<string, any> : {}
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function inlineCode(value: string): string {
  return value.replaceAll('`', '').trim() || '未命名会话'
}
