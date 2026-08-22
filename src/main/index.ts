// 每个 appType 独立保存的策略 + 框选区域
import { app, shell, BrowserWindow, ipcMain, desktopCapturer } from 'electron'
import { join } from 'path'
import { copyFileSync, existsSync, mkdirSync, readdirSync, renameSync, statSync } from 'fs'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { checkAndRequestPermissions } from './permission'
import Store from 'electron-store'
import { AIClient } from '../core/ai-client'
import { DesktopDevice } from '../core/device'
import { RPADevice } from '../core/rpa-device'
import { BoxSelectDevice } from '../core/box-select-device'
import { RuntimeHost } from '../core/runtime-host'
import {
  createInitialGenericChannelState,
  GenericChannelSession
} from '../core/generic-channel-session'
import { AppType, BoxRegions, CaptureStrategy, isWechatLike } from '../core/rpa/types'
import { runBoxSelectWizard, type WizardStepKey } from './overlay-window'
import {
  BUILTIN_DOUBAO_PROVIDER_ID,
  getBuiltinDoubaoInstalledInfo,
  getBuiltinDoubaoManifestForUi,
  getInstalledProviderManifest,
  installProviderFromUrl,
  InstalledProviderInfo,
  loadBuiltinDoubaoProvider,
  loadInstalledProvider
} from './provider-bundle'
import {
  SkillEngineController,
  SkillPauseResult,
  SkillStartResult,
  startSkillServer,
  stopSkillServer
} from './skill-server'
import {
  listTraceSessions,
  readTraceScreenshot,
  readTraceSession,
  TraceRecorder
} from '../core/trace/trace-recorder'
import { TraceStepInput } from '../core/trace/trace-types'
import { WechatFriendAutomation } from '../core/wechat-friend-automation'
import {
  AddWechatFriendRequest,
  WechatFriendAddMode,
  WechatFriendAutoResult,
  WechatFriendCustomer,
  WechatFriendOperationStatus
} from '../core/wechat-friend-types'
import { fetchNextPendingCustomer, updateCustomerStatus } from '../core/wechat-friend-api'
import { ExperienceStore, NewExperienceCard } from '../core/memory/experience-store'
import { induceCardsFromSession } from '../core/memory/learn-from-session'
const StoreClass = typeof Store === 'function' ? Store : ((Store as any).default as typeof Store)

interface PerAppCapture {
  strategy: CaptureStrategy
  regions: BoxRegions | null
}

/** 本地智能体：本质是「名称 + OpenAI 兼容的 apiKey/prompt 配置」，运行在同一个内置回复运行时上。 */
interface LocalAgent {
  id: string
  name: string
  config: {
    apiKey: string
    model: string
    baseURL: string
    systemPrompt: string
  }
}

const DEFAULT_AGENT_CONFIG = {
  apiKey: '',
  model: 'doubao-seed-2-0-lite-260215',
  baseURL: 'https://ark.cn-beijing.volces.com/api/v3',
  systemPrompt: ''
}

interface AppSettings {
  locale: 'zh' | 'en'
  appType: AppType
  vision: {
    apiKey: string
    model: string
    baseURL: string
  }
  chatProvider: {
    manifestUrl: string
    installed: InstalledProviderInfo | null
    config: Record<string, any>
  }
  // 本地智能体列表 + 当前启用项
  agents: LocalAgent[]
  activeAgentId: string
  // 客户记录后端地址（自动添加好友的取号与状态回写用）
  customerApiUrl: string
  // 持续添加好友时，加完一个后等待的间隔（分钟），0 表示立即添加下一个
  friendAddIntervalMinutes: number
  // 默认抓取策略（仅当 appType 没有 per-app 覆盖时生效）
  defaultCaptureStrategy: CaptureStrategy
  capture: Partial<Record<AppType, PerAppCapture>>
}

type ProviderConfigFieldType = 'text' | 'password' | 'url' | 'select' | 'textarea'

type ProviderConfigField = {
  key: string
  label: string
  type: ProviderConfigFieldType
  required?: boolean
  readonly?: boolean
  placeholder?: string
  hint?: string
  defaultValue?: string
  options?: Array<{ label: string; value: string }>
}

type ProviderCatalogItem = {
  id: string
  name: string
  description?: string
  version: string
  manifestUrl: string
  capabilities?: string[]
  configSchema: {
    fields: ProviderConfigField[]
  }
}

type ProviderHubCache = {
  sourceUrl: string
  fetchedAt: string
  providers: ProviderCatalogItem[]
}

type ProviderHubEntry = {
  id?: unknown
  enabled?: unknown
  manifestUrl?: unknown
}

type ProviderHubManifest = {
  id?: unknown
  name?: unknown
  description?: unknown
  version?: unknown
  capabilities?: unknown
  configSchema?: unknown
}

const DEFAULT_PROVIDER_HUB_URL =
  process.env.SIGHTFLOW_PROVIDER_HUB_URL || 'https://sightflow.dev/provider-hub.json'
const PROVIDER_HUB_CACHE_KEY = 'providerHubCache'
const FETCH_TIMEOUT_MS = 10_000

// ── userData 目录迁移 ──
// 应用重命名为 RAuto 后，Electron 的 userData 目录从 %APPDATA%/sightflow-desktop-agent
// 变为 %APPDATA%/RAuto。为不丢失已有设置（settings.json）、工作记忆（worktrace）与已安装
// 服务（providers），启动时把旧目录中的关键数据复制到新目录，并把旧目录改名为 .bak 备份。
// 必须在 settingsStore 实例化之前执行：electron-store 在构造时就读取 userData 下的配置文件。
const APP_DISPLAY_NAME = 'RAuto'

// 固定 userData 目录为 %APPDATA%/RAuto，保证开发（electron-vite）与打包（electron-builder）
// 环境使用完全一致的目录，不依赖 productName 在不同启动方式下的解析差异。
function pinUserDataDir(): void {
  try {
    const expected = join(app.getPath('appData'), APP_DISPLAY_NAME)
    if (app.getPath('userData') !== expected) {
      mkdirSync(expected, { recursive: true })
      app.setPath('userData', expected)
    }
  } catch (error) {
    console.error('[init] 设置 userData 目录失败', error)
  }
}

const LEGACY_USERDATA_DIR_NAMES = ['sightflow-desktop-agent', 'SightFlow']
const MIGRATABLE_USERDATA_ITEMS = [
  'settings.json',
  'worktrace',
  'providers',
  'Preferences',
  'Local Storage'
]

function copyPathRecursive(fromPath: string, toPath: string): void {
  if (!existsSync(fromPath)) return
  if (!statSync(fromPath).isDirectory()) {
    copyFileSync(fromPath, toPath)
    return
  }
  mkdirSync(toPath, { recursive: true })
  for (const entry of readdirSync(fromPath)) {
    copyPathRecursive(join(fromPath, entry), join(toPath, entry))
  }
}

function migrateLegacyUserData(): void {
  try {
    const targetDir = app.getPath('userData')
    // 新目录已初始化（存在 settings.json）时不迁移，避免覆盖用户新数据。
    if (existsSync(join(targetDir, 'settings.json'))) return

    const appDataDir = app.getPath('appData')
    for (const legacyName of LEGACY_USERDATA_DIR_NAMES) {
      const legacyDir = join(appDataDir, legacyName)
      if (!existsSync(join(legacyDir, 'settings.json'))) continue

      for (const item of MIGRATABLE_USERDATA_ITEMS) {
        copyPathRecursive(join(legacyDir, item), join(targetDir, item))
      }
      console.log(`[migrate] 已将 userData 从 ${legacyDir} 迁移到 ${targetDir}`)

      // 备份旧目录，避免每次启动重复迁移，同时保留可回退的数据。
      const backupDir = `${legacyDir}.bak`
      if (!existsSync(backupDir)) {
        try {
          renameSync(legacyDir, backupDir)
        } catch (error) {
          console.error(`[migrate] 重命名旧目录失败：${legacyDir}`, error)
        }
      }
    }
  } catch (error) {
    console.error('[migrate] 迁移 userData 失败', error)
  }
}

pinUserDataDir()
migrateLegacyUserData()

const settingsStore = new StoreClass({
  name: 'settings',
  defaults: {
    locale: 'zh',
    appType: 'wechat',
    vision: { apiKey: '', model: '', baseURL: '' },
    chatProvider: {
      manifestUrl: '',
      installed: null,
      config: {}
    },
    agents: [],
    activeAgentId: '',
    customerApiUrl: 'http://192.168.8.94:8500',
    friendAddIntervalMinutes: 0,
    defaultCaptureStrategy: 'auto',
    capture: {}
  }
})

let runtime: RuntimeHost<ReturnType<typeof createInitialGenericChannelState>> | null = null
let runtimeDevice: DesktopDevice | null = null
let wechatFriendAutomation: WechatFriendAutomation | null = null
let wechatFriendStatus: WechatFriendOperationStatus = { stage: 'idle' }
let wechatFriendStopRequested = false
let settingsWindow: BrowserWindow | null = null
let memoryWindow: BrowserWindow | null = null

// ── 工作记忆（work-trace + 经验卡片）单例，首次使用时初始化 ──
let traceRecorderInstance: TraceRecorder | null = null
let experienceStoreInstance: ExperienceStore | null = null

function worktraceBaseDir(): string {
  return join(app.getPath('userData'), 'worktrace')
}

function getTraceRecorder(): TraceRecorder {
  if (!traceRecorderInstance) {
    traceRecorderInstance = new TraceRecorder(worktraceBaseDir())
  }
  return traceRecorderInstance
}

function getExperienceStore(): ExperienceStore {
  if (!experienceStoreInstance) {
    experienceStoreInstance = new ExperienceStore(join(worktraceBaseDir(), 'memory', 'cards.json'))
  }
  return experienceStoreInstance
}

function broadcastToRenderers(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, payload)
  }
}

function recordAndBroadcastTrace(input: TraceStepInput): void {
  const step = getTraceRecorder().record(input)
  if (!step) return

  const refs = step.reasoning?.memoryRefs
  if (step.phase === 'act' && step.action?.kind === 'send' && refs?.length) {
    getExperienceStore().recordUsage(refs, step.outcome?.status === 'ok')
  }
  broadcastToRenderers('trace:step', { sessionId: step.sessionId, step })
}

function updateWechatFriendStatus(status: WechatFriendOperationStatus): void {
  wechatFriendStatus = status
  broadcastToRenderers('wechatFriend:state', status)
}

function logWechatFriend(type: 'thinking' | 'reply' | 'skip' | 'error', content: string): void {
  broadcastToRenderers('engine:log', { type, content })
}

function createWindow(): void {
  // Create the browser window.
  const mainWindow = new BrowserWindow({
    width: 420,
    height: 700,
    minWidth: 360,
    minHeight: 500,
    show: false,
    autoHideMenuBar: true,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 12, y: 12 },
    backgroundColor: '#0a0b10',
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  // HMR for renderer base on electron-vite cli.
  // Load the remote URL for development or the local html file for production.
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

function createSettingsWindow(): void {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.show()
    settingsWindow.focus()
    return
  }

  settingsWindow = new BrowserWindow({
    width: 900,
    height: 720,
    minWidth: 860,
    minHeight: 640,
    show: false,
    autoHideMenuBar: true,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 14, y: 14 },
    backgroundColor: '#0a0b10',
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })

  settingsWindow.on('ready-to-show', () => {
    settingsWindow?.show()
  })

  settingsWindow.on('closed', () => {
    settingsWindow = null
  })

  settingsWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    settingsWindow.loadURL(`${process.env['ELECTRON_RENDERER_URL']}?window=settings`)
  } else {
    settingsWindow.loadFile(join(__dirname, '../renderer/index.html'), {
      query: { window: 'settings' }
    })
  }
}

function createMemoryWindow(): void {
  if (memoryWindow && !memoryWindow.isDestroyed()) {
    memoryWindow.show()
    memoryWindow.focus()
    return
  }

  memoryWindow = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 980,
    minHeight: 640,
    show: false,
    autoHideMenuBar: true,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 14, y: 14 },
    backgroundColor: '#0a0b10',
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })

  memoryWindow.on('ready-to-show', () => {
    memoryWindow?.show()
  })

  memoryWindow.on('closed', () => {
    memoryWindow = null
  })

  memoryWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    memoryWindow.loadURL(`${process.env['ELECTRON_RENDERER_URL']}?window=memory`)
  } else {
    memoryWindow.loadFile(join(__dirname, '../renderer/index.html'), {
      query: { window: 'memory' }
    })
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function normalizeFieldType(value: unknown, format?: unknown): ProviderConfigFieldType {
  if (value === 'password' || value === 'url' || value === 'select' || value === 'textarea') {
    return value
  }
  if (format === 'password') return 'password'
  if (format === 'uri' || format === 'url') return 'url'
  return 'text'
}

function normalizeOptions(value: unknown): Array<{ label: string; value: string }> | undefined {
  if (!Array.isArray(value)) return undefined
  const options = value
    .map((item) => {
      if (typeof item === 'string') return { label: item, value: item }
      if (!isRecord(item)) return null
      const label = typeof item.label === 'string' ? item.label : String(item.value || '')
      const optionValue = typeof item.value === 'string' ? item.value : ''
      return optionValue ? { label, value: optionValue } : null
    })
    .filter(Boolean) as Array<{ label: string; value: string }>
  return options.length ? options : undefined
}

function normalizeManifestConfigFields(configSchema: unknown): ProviderConfigField[] {
  if (!isRecord(configSchema)) return []

  const required = Array.isArray(configSchema.required)
    ? configSchema.required.filter((key): key is string => typeof key === 'string')
    : []

  if (Array.isArray(configSchema.fields)) {
    return configSchema.fields
      .map((field) => {
        if (!isRecord(field) || typeof field.key !== 'string') return null
        return {
          key: field.key,
          label: typeof field.label === 'string' ? field.label : field.key,
          type: normalizeFieldType(field.type),
          required: field.required === true || required.includes(field.key),
          readonly: field.readonly === true,
          placeholder: typeof field.placeholder === 'string' ? field.placeholder : undefined,
          hint: typeof field.hint === 'string' ? field.hint : undefined,
          defaultValue: typeof field.defaultValue === 'string' ? field.defaultValue : undefined,
          options: normalizeOptions(field.options)
        }
      })
      .filter(Boolean) as ProviderConfigField[]
  }

  if (!isRecord(configSchema.properties)) return []

  return Object.entries(configSchema.properties).map(([key, property]) => {
    const schema = isRecord(property) ? property : {}
    const title = typeof schema.title === 'string' ? schema.title : key
    return {
      key,
      label: title,
      type: normalizeFieldType(schema.type, schema.format),
      required: required.includes(key),
      readonly: schema.readonly === true || schema.readOnly === true,
      placeholder: typeof schema.placeholder === 'string' ? schema.placeholder : undefined,
      hint: typeof schema.description === 'string' ? schema.description : undefined,
      defaultValue: typeof schema.default === 'string' ? schema.default : undefined,
      options: normalizeOptions(schema.enum)
    }
  })
}

async function fetchJson(url: string): Promise<unknown> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    const response = await fetch(url, { signal: controller.signal })
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText}`)
    }
    return await response.json()
  } catch (error: unknown) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error(`请求超时（${FETCH_TIMEOUT_MS / 1000}s）：${url}`)
    }
    throw error
  } finally {
    clearTimeout(timer)
  }
}

function getCachedProviderHub(): ProviderHubCache | null {
  const cached = settingsStore.get(PROVIDER_HUB_CACHE_KEY)
  if (!isRecord(cached) || !Array.isArray(cached.providers)) return null
  return cached as ProviderHubCache
}

async function fetchProviderHub(url = DEFAULT_PROVIDER_HUB_URL): Promise<ProviderHubCache> {
  const hub = await fetchJson(url)
  if (!isRecord(hub) || !Array.isArray(hub.providers)) {
    throw new Error('Provider hub JSON must contain a providers array')
  }

  const providers = await Promise.all(
    (hub.providers as ProviderHubEntry[])
      .filter((entry) => entry?.enabled !== false && typeof entry?.manifestUrl === 'string')
      .map(async (entry) => {
        const manifestUrl = entry.manifestUrl as string
        const manifest = (await fetchJson(manifestUrl)) as ProviderHubManifest
        const id =
          typeof manifest.id === 'string'
            ? manifest.id
            : typeof entry.id === 'string'
              ? entry.id
              : manifestUrl
        const name = typeof manifest.name === 'string' ? manifest.name : id
        const version = typeof manifest.version === 'string' ? manifest.version : '0.0.0'
        const capabilities = Array.isArray(manifest.capabilities)
          ? manifest.capabilities.filter((item): item is string => typeof item === 'string')
          : undefined
        const description =
          typeof manifest.description === 'string' ? manifest.description : undefined

        return {
          id,
          name,
          description,
          version,
          manifestUrl,
          capabilities,
          configSchema: {
            fields: normalizeManifestConfigFields(manifest.configSchema)
          }
        }
      })
  )

  const cache = {
    sourceUrl: url,
    fetchedAt: new Date().toISOString(),
    providers
  }
  settingsStore.set(PROVIDER_HUB_CACHE_KEY, cache)
  return cache
  
}
// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.whenReady().then(async () => {
  // Set app user model id for windows
  electronApp.setAppUserModelId('com.electron')

  // 首次运行时把旧版单一 chatProvider 配置迁移为本地智能体列表。
  seedLocalAgents()

  // 检查和请求 macOS 需要的权限
  await checkAndRequestPermissions()

  // Default open or close DevTools by F12 in development
  // and ignore CommandOrControl + R in production.
  // see https://github.com/alex8088/electron-toolkit/tree/master/packages/utils
  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  // IPC test
  ipcMain.on('ping', () => console.log('pong'))

  // ── Settings 持久化 ──
  ipcMain.handle('settings:getAll', async () => {
    return normalizeSettings(settingsStore.store)
  })

  ipcMain.handle('settings:get', async (_event, key: string) => {
    const settings = normalizeSettings(settingsStore.store)
    return (settings as Record<string, any>)[key]
  })

  ipcMain.handle('settings:set', async (_event, data: Record<string, any>) => {
    const current = normalizeSettings(settingsStore.store)
    const next = normalizeSettings({
      ...current,
      ...data,
      vision: {
        ...current.vision,
        ...(data.vision || {})
      },
      chatProvider: {
        ...current.chatProvider,
        ...(data.chatProvider || {}),
        config: {
          ...current.chatProvider.config,
          ...(data.chatProvider?.config || {})
        }
      },
      capture: {
        ...current.capture,
        ...(data.capture || {})
      }
    })

    settingsStore.set(next as any)
    return { success: true }
  })

  ipcMain.handle('provider:installFromUrl', async (_event, manifestUrl: string) => {
    try {
      const result = await installProviderFromUrl(manifestUrl)
      const current = normalizeSettings(settingsStore.store)
      settingsStore.set({
        ...current,
        chatProvider: {
          ...current.chatProvider,
          manifestUrl,
          installed: result.installed,
          config: withSchemaDefaults(result.manifest.configSchema, current.chatProvider.config)
        }
      } as any)

      return {
        success: true,
        installed: result.installed,
        manifest: result.manifest
      }
    } catch (error: any) {
      return { success: false, error: error?.message || String(error) }
    }
  })

  ipcMain.handle('provider:getInstalled', async () => {
    const settings = normalizeSettings(settingsStore.store)

    // 用户安装过自定义 provider：原样返回
    if (settings.chatProvider.installed) {
      const manifest = await getInstalledProviderManifest(settings.chatProvider.installed)
      return {
        installed: settings.chatProvider.installed,
        manifest,
        isBuiltinDefault: false
      }
    }

    // 没装过 → 回退到内置 doubao（apiKey 字段已剥离，使用视觉密钥）
    const installed = await getBuiltinDoubaoInstalledInfo()
    const manifest = await getBuiltinDoubaoManifestForUi()
    return {
      installed,
      manifest,
      isBuiltinDefault: true
    }
  })

  ipcMain.handle('providerHub:getCatalog', async () => {
    // 智能体目录只读本地缓存，不联网拉取远端；内置豆包始终可用。
    const cached = getCachedProviderHub()
    if (cached) return { success: true, catalog: cached }
    return { success: true, catalog: null }
  })

  ipcMain.handle('providerHub:update', async () => {
    try {
      const catalog = await fetchProviderHub()
      return { success: true, catalog }
    } catch (error: unknown) {
      const cached = getCachedProviderHub()
      const message = error instanceof Error ? error.message : String(error)
      return { success: false, error: message, catalog: cached }
    }
  })

  // ── 本地智能体 CRUD ──
  ipcMain.handle('agent:list', async () => {
    const settings = normalizeSettings(settingsStore.store)
    return { agents: settings.agents, activeAgentId: settings.activeAgentId }
  })

  ipcMain.handle('agent:add', async (_event, name?: string) => {
    const settings = normalizeSettings(settingsStore.store)
    const agent: LocalAgent = {
      id: `agent-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      name:
        typeof name === 'string' && name.trim()
          ? name.trim()
          : `智能体 ${settings.agents.length + 1}`,
      config: { ...DEFAULT_AGENT_CONFIG }
    }
    const agents = [...settings.agents, agent]
    const activeAgentId = settings.activeAgentId || agent.id
    settingsStore.set({ ...settings, agents, activeAgentId } as any)
    return { success: true, agent, agents, activeAgentId }
  })

  ipcMain.handle('agent:rename', async (_event, id: string, name: string) => {
    const settings = normalizeSettings(settingsStore.store)
    const trimmed = typeof name === 'string' ? name.trim() : ''
    if (!trimmed) return { success: false, error: '名称不能为空' }
    if (!settings.agents.some((a) => a.id === id)) return { success: false, error: '智能体不存在' }
    const agents = settings.agents.map((a) => (a.id === id ? { ...a, name: trimmed } : a))
    settingsStore.set({ ...settings, agents } as any)
    return { success: true, agents }
  })

  ipcMain.handle('agent:delete', async (_event, id: string) => {
    const settings = normalizeSettings(settingsStore.store)
    if (settings.agents.length <= 1) return { success: false, error: '至少保留一个智能体' }
    const agents = settings.agents.filter((a) => a.id !== id)
    if (agents.length === settings.agents.length) return { success: false, error: '智能体不存在' }
    const activeAgentId = settings.activeAgentId === id ? agents[0].id : settings.activeAgentId
    settingsStore.set({ ...settings, agents, activeAgentId } as any)
    return { success: true, agents, activeAgentId }
  })

  ipcMain.handle(
    'agent:save',
    async (
      _event,
      id: string,
      patch: { name?: string; config?: Partial<LocalAgent['config']> }
    ) => {
      const settings = normalizeSettings(settingsStore.store)
      const target = settings.agents.find((a) => a.id === id)
      if (!target) return { success: false, error: '智能体不存在' }
      const agents = settings.agents.map((a) => {
        if (a.id !== id) return a
        const cfg = patch?.config
        return {
          ...a,
          name: typeof patch?.name === 'string' && patch.name.trim() ? patch.name.trim() : a.name,
          config: {
            apiKey: typeof cfg?.apiKey === 'string' ? cfg.apiKey : a.config.apiKey,
            model: typeof cfg?.model === 'string' ? cfg.model : a.config.model,
            baseURL: typeof cfg?.baseURL === 'string' ? cfg.baseURL : a.config.baseURL,
            systemPrompt:
              typeof cfg?.systemPrompt === 'string' ? cfg.systemPrompt : a.config.systemPrompt
          }
        }
      })
      settingsStore.set({ ...settings, agents } as any)
      return { success: true, agents }
    }
  )

  ipcMain.handle('agent:activate', async (_event, id: string) => {
    const settings = normalizeSettings(settingsStore.store)
    const target = settings.agents.find((a) => a.id === id)
    if (!target) return { success: false, error: '智能体不存在' }
    // 本地智能体共用内置 OpenAI 兼容回复运行时；把激活项的配置写入 chatProvider 供引擎读取。
    settingsStore.set({
      ...settings,
      activeAgentId: id,
      chatProvider: {
        manifestUrl: '',
        installed: null,
        config: { ...target.config }
      }
    } as any)
    return { success: true, activeAgentId: id, agents: settings.agents }
  })

  ipcMain.handle('settings:open', async () => {
    createSettingsWindow()
    return { success: true }
  })

  // ── 工作记忆：轨迹查询 / 回放 ──
  ipcMain.handle('memory:open', async () => {
    createMemoryWindow()
    return { success: true }
  })

  ipcMain.handle('trace:listSessions', async () => {
    return listTraceSessions(worktraceBaseDir())
  })

  ipcMain.handle('trace:getSession', async (_event, sessionId: string) => {
    if (typeof sessionId !== 'string' || !sessionId) return null
    return readTraceSession(worktraceBaseDir(), sessionId)
  })

  ipcMain.handle(
    'trace:getScreenshot',
    async (_event, sessionId: string, screenshotPath: string) => {
      if (typeof sessionId !== 'string' || typeof screenshotPath !== 'string') return null
      return readTraceScreenshot(worktraceBaseDir(), sessionId, screenshotPath)
    }
  )

  // ── 工作记忆：经验卡片 ──
  ipcMain.handle('memory:listCards', async () => {
    return getExperienceStore().listCards()
  })

  ipcMain.handle('memory:learnFromSession', async (_event, sessionId: string) => {
    try {
      const settings = normalizeSettings(settingsStore.store)
      const visionError = validateVisionSettings(settings)
      if (visionError) {
        return { success: false, error: visionError }
      }
      const data = await readTraceSession(worktraceBaseDir(), sessionId)
      if (!data || data.steps.length === 0) {
        return { success: false, error: '该轨迹暂无可学习的步骤' }
      }

      const client = new AIClient({
        apiKey: settings.vision.apiKey,
        model: settings.vision.model,
        baseURL: settings.vision.baseURL
      })
      const induced = await induceCardsFromSession(client, data.session, data.steps)
      if (induced.length === 0) {
        return { success: true, cards: [] }
      }

      const cards = getExperienceStore().addCards(
        induced.map((item) => ({
          scenario: item.scenario,
          guidance: item.guidance,
          rationale: item.rationale,
          source: 'agent_summary' as const,
          evidence: { sessionId, stepIds: item.stepIds }
        }))
      )
      return { success: true, cards }
    } catch (error: any) {
      return { success: false, error: error?.message || String(error) }
    }
  })

  ipcMain.handle('memory:addCard', async (_event, input: NewExperienceCard) => {
    if (!input?.scenario?.trim() || !input?.guidance?.trim()) {
      return { success: false, error: '场景和做法不能为空' }
    }
    const source: NewExperienceCard['source'] =
      input.source === 'human_takeover' || input.source === 'manual' ? input.source : 'manual'
    const cards = getExperienceStore().addCards([
      {
        scenario: input.scenario,
        guidance: input.guidance,
        rationale: input.rationale,
        source,
        evidence: input.evidence
      }
    ])
    return { success: true, cards }
  })

  ipcMain.handle('memory:deleteCard', async (_event, cardId: string) => {
    return { success: getExperienceStore().deleteCard(cardId) }
  })

  ipcMain.handle('memory:setCardEnabled', async (_event, cardId: string, enabled: boolean) => {
    return { success: getExperienceStore().setEnabled(cardId, enabled === true) }
  })

  // ── 微信扩展操作：添加好友（准备与最终发送分成两段） ──
  ipcMain.handle('wechatFriend:getStatus', async () => wechatFriendStatus)

  ipcMain.handle('wechatFriend:prepare', async (_event, request: AddWechatFriendRequest) => {
    if (runtime?.isRunning()) {
      return { success: false, stage: 'failed', error: '请先停止消息监控，再执行添加好友' }
    }
    if (wechatFriendStatus.stage === 'preparing' || wechatFriendStatus.stage === 'sending') {
      return { success: false, stage: wechatFriendStatus.stage, error: '已有好友操作正在执行' }
    }
    if (wechatFriendStatus.stage === 'awaiting_confirmation') {
      return {
        success: false,
        stage: 'awaiting_confirmation',
        error: '已有好友申请等待确认，请先发送或取消'
      }
    }

    const settings = normalizeSettings(settingsStore.store)
    const visionError = validateVisionSettings(settings)
    if (visionError) {
      return { success: false, stage: 'failed', error: visionError }
    }

    const account = String(request?.account || '').trim()
    const recorder = getTraceRecorder()
    const session = recorder.startSession({
      appType: 'wechat',
      engineVersion: app.getVersion(),
      providerId: 'wechat-friend-operation',
      model: settings.vision.model
    })
    updateWechatFriendStatus({ stage: 'preparing', account, sessionId: session.sessionId })

    const client = new AIClient({
      apiKey: settings.vision.apiKey,
      model: settings.vision.model,
      baseURL: settings.vision.baseURL
    })
    const automation = new WechatFriendAutomation(client, {
      log: logWechatFriend,
      trace: recordAndBroadcastTrace
    })
    wechatFriendAutomation = automation

    try {
      await automation.prepare(request)
      updateWechatFriendStatus({
        stage: 'awaiting_confirmation',
        account,
        sessionId: session.sessionId,
        detail: '申请信息已填写，等待确认发送'
      })
      return { success: true, stage: 'awaiting_confirmation' }
    } catch (error: any) {
      const message = error?.message || String(error)
      recordAndBroadcastTrace({
        phase: 'verify',
        summary: '添加微信好友准备失败',
        outcome: { status: 'fail', detail: message }
      })
      recorder.endSession()
      wechatFriendAutomation = null
      updateWechatFriendStatus({ stage: 'failed', account, detail: message })
      logWechatFriend('error', `添加好友失败：${message}`)
      return { success: false, stage: 'failed', error: message }
    }
  })

  ipcMain.handle('wechatFriend:confirm', async () => {
    if (!wechatFriendAutomation || wechatFriendStatus.stage !== 'awaiting_confirmation') {
      return { success: false, stage: 'failed', error: '没有等待确认的好友申请' }
    }

    const account = wechatFriendStatus.account
    updateWechatFriendStatus({
      ...wechatFriendStatus,
      stage: 'sending',
      detail: '正在发送好友申请'
    })
    try {
      await wechatFriendAutomation.confirm()
      getTraceRecorder().endSession()
      wechatFriendAutomation = null
      updateWechatFriendStatus({ stage: 'completed', account, detail: '好友申请已发送' })
      return { success: true, stage: 'completed' }
    } catch (error: any) {
      const message = error?.message || String(error)
      recordAndBroadcastTrace({
        phase: 'verify',
        summary: '发送微信好友申请失败',
        outcome: { status: 'fail', detail: message }
      })
      getTraceRecorder().endSession()
      wechatFriendAutomation = null
      updateWechatFriendStatus({ stage: 'failed', account, detail: message })
      logWechatFriend('error', `发送好友申请失败：${message}`)
      return { success: false, stage: 'failed', error: message }
    }
  })

  ipcMain.handle('wechatFriend:cancel', async () => {
    if (wechatFriendStatus.stage === 'awaiting_confirmation') {
      wechatFriendAutomation?.cancel()
      recordAndBroadcastTrace({
        actor: 'human',
        phase: 'verify',
        summary: '人工取消发送微信好友申请',
        action: { kind: 'wait', payload: 'cancelled_before_send' },
        outcome: { status: 'skip' }
      })
      getTraceRecorder().endSession()
    }
    wechatFriendAutomation = null
    updateWechatFriendStatus({ stage: 'cancelled', account: wechatFriendStatus.account })
    logWechatFriend('skip', '已取消本次好友申请；微信窗口中已填写内容不会自动清除')
    return { success: true, stage: 'cancelled' }
  })

  // ── 微信扩展操作：全自动添加好友（取号 → 添加 → 写库） ──

  /**
   * 添加单个待添加客户：搜索、填写申请、发送并回写数据库。
   * 每次调用独立开启/结束一个 trace 会话；失败时清理自动化并抛错，由调用方决定是否继续。
   */
  async function autoAddOneCustomer(
    customer: WechatFriendCustomer,
    verificationMessage: string,
    client: AIClient,
    settings: AppSettings
  ): Promise<{ wechatId: string | null }> {
    const account = customer.wechat
    const remark = `${customer.name}-${customer.channel}`
    const recorder = getTraceRecorder()
    const session = recorder.startSession({
      appType: 'wechat',
      engineVersion: app.getVersion(),
      providerId: 'wechat-friend-auto-operation',
      model: settings.vision.model
    })
    updateWechatFriendStatus({ stage: 'preparing', account, sessionId: session.sessionId })

    const automation = new WechatFriendAutomation(client, {
      log: logWechatFriend,
      trace: recordAndBroadcastTrace
    })
    wechatFriendAutomation = automation

    try {
      logWechatFriend(
        'thinking',
        `取到待添加客户：${customer.name}（微信号 ${account}，渠道 ${customer.channel}）`
      )
      updateWechatFriendStatus({
        stage: 'sending',
        account,
        sessionId: session.sessionId,
        detail: '正在自动添加并发送申请'
      })

      const { wechatId } = await automation.run({
        account,
        verificationMessage: verificationMessage || undefined,
        remark
      })

      try {
        await updateCustomerStatus(customer.id, '已发申请', wechatId, settings.customerApiUrl)
        logWechatFriend(
          'reply',
          `已回写客户 ${customer.name} 状态为「已发申请」${wechatId ? `（added_by_wechat=${wechatId}）` : ''}`
        )
      } catch (error: any) {
        logWechatFriend(
          'error',
          `好友申请已发送，但回写数据库失败：${error?.message || String(error)}`
        )
      }

      recorder.endSession()
      wechatFriendAutomation = null
      return { wechatId }
    } catch (error) {
      recorder.endSession()
      wechatFriendAutomation = null
      throw error
    }
  }

  ipcMain.handle(
    'wechatFriend:autoAdd',
    async (
      _event,
      input: { verificationMessage?: string; mode?: WechatFriendAddMode }
    ): Promise<WechatFriendAutoResult> => {
      if (runtime?.isRunning()) {
        return { success: false, stage: 'failed', error: '请先停止消息监控，再执行添加好友' }
      }
      if (
        wechatFriendStatus.stage === 'preparing' ||
        wechatFriendStatus.stage === 'sending' ||
        wechatFriendStatus.stage === 'awaiting_confirmation'
      ) {
        return {
          success: false,
          stage: wechatFriendStatus.stage,
          error: '已有好友操作正在执行'
        }
      }

      const settings = normalizeSettings(settingsStore.store)
      const visionError = validateVisionSettings(settings)
      if (visionError) {
        return { success: false, stage: 'failed', error: visionError }
      }
      const mode: WechatFriendAddMode = input?.mode === 'continuous' ? 'continuous' : 'single'
      const verificationMessage =
        typeof input?.verificationMessage === 'string' ? input.verificationMessage.trim() : ''

      const client = new AIClient({
        apiKey: settings.vision.apiKey,
        model: settings.vision.model,
        baseURL: settings.vision.baseURL
      })

      wechatFriendStopRequested = false
      let addedCount = 0
      let skippedCount = 0
      let lastCustomer: WechatFriendCustomer | undefined
      let lastWechatId: string | null = null

      try {
        while (true) {
          if (wechatFriendStopRequested) break

          // 取号
          let customer: WechatFriendCustomer | null
          try {
            customer = await fetchNextPendingCustomer(settings.customerApiUrl)
          } catch (error: any) {
            // 已添加过客户时，取号失败不中断整批，仅记录并结束本轮。
            if (addedCount > 0) {
              logWechatFriend('error', `继续取号失败，已停止：${error?.message || String(error)}`)
              break
            }
            return { success: false, stage: 'failed', error: error?.message || String(error) }
          }
          if (!customer) break

          try {
            const { wechatId } = await autoAddOneCustomer(
              customer,
              verificationMessage,
              client,
              settings
            )
            addedCount += 1
            lastCustomer = customer
            lastWechatId = wechatId
          } catch (error: any) {
            // 用户点击“停止添加”会立即中断当前自动化，属于正常结束而非失败。
            if (error?.name === 'WechatFriendStoppedError') break

            // 微信提示无法找到该用户：标记为跳过，继续后续账号，不中断整批。
            if (error?.name === 'WechatFriendUserNotFoundError') {
              try {
                await updateCustomerStatus(customer.id, '跳过', null, settings.customerApiUrl)
                logWechatFriend(
                  'skip',
                  `客户 ${customer.name}（微信号 ${customer.wechat}）无法找到该用户，已标记为跳过`
                )
              } catch (updateError: any) {
                logWechatFriend(
                  'error',
                  `客户 ${customer.name} 标记为跳过失败：${updateError?.message || String(updateError)}`
                )
              }
              skippedCount += 1
              if (mode === 'single') break
              continue
            }

            // 微信触发风控（操作过于频繁）：本次申请未真正发出成功，标记为跳过，继续后续账号。
            if (error?.name === 'WechatFriendRateLimitedError') {
              try {
                await updateCustomerStatus(customer.id, '跳过', null, settings.customerApiUrl)
                logWechatFriend(
                  'skip',
                  `客户 ${customer.name}（微信号 ${customer.wechat}）触发微信风控（操作过于频繁），本次未添加成功，已标记为跳过`
                )
              } catch (updateError: any) {
                logWechatFriend(
                  'error',
                  `客户 ${customer.name} 标记为跳过失败：${updateError?.message || String(updateError)}`
                )
              }
              skippedCount += 1
              if (mode === 'single') break
              continue
            }

            // 该微信号已经是当前登录微信的好友（此前被人工手动添加过）：
            // 回写“已申请过”，并把 added_by_wechat 记录为当前登录微信号，继续后续账号。
            if (error?.name === 'WechatFriendAlreadyFriendError') {
              try {
                await updateCustomerStatus(
                  customer.id,
                  '已申请过',
                  error?.wechatId || null,
                  settings.customerApiUrl
                )
                logWechatFriend(
                  'skip',
                  `客户 ${customer.name}（微信号 ${customer.wechat}）已经是当前微信号的好友，已标记为「已申请过」${error?.wechatId ? `（added_by_wechat=${error.wechatId}）` : ''}`
                )
              } catch (updateError: any) {
                logWechatFriend(
                  'error',
                  `客户 ${customer.name} 标记为「已申请过」失败：${updateError?.message || String(updateError)}`
                )
              }
              skippedCount += 1
              if (mode === 'single') break
              continue
            }

            throw error
          }

          // 单次模式只处理一个客户。
          if (mode === 'single') break

          // 持续模式：加完一个好友后，按配置的间隔等待，再取下一个，避免触发微信风控。
          // 等待期间仍可通过“停止添加”立即中断。
          const intervalMinutes = settings.friendAddIntervalMinutes
          if (intervalMinutes > 0) {
            logWechatFriend(
              'thinking',
              `已添加 ${addedCount} 个好友，等待 ${intervalMinutes} 分钟后再添加下一位…`
            )
            const deadline = Date.now() + intervalMinutes * 60 * 1000
            while (Date.now() < deadline) {
              if (wechatFriendStopRequested) break
              await new Promise((resolve) => setTimeout(resolve, 1000))
            }
            if (wechatFriendStopRequested) break
          }
        }

        const stopped = wechatFriendStopRequested
        const parts: string[] = []
        if (addedCount > 0) parts.push(`已发送 ${addedCount} 个好友申请`)
        if (skippedCount > 0) parts.push(`跳过 ${skippedCount} 个无法添加的账号`)
        const detail =
          parts.length > 0
            ? parts.join('，') + (stopped ? '（已停止）' : '')
            : stopped
              ? '已停止'
              : '当前没有待添加的客户'
        updateWechatFriendStatus({
          stage: 'completed',
          account: lastCustomer?.wechat,
          detail
        })
        return {
          success: true,
          stage: 'completed',
          customer: lastCustomer,
          wechatId: lastWechatId,
          addedCount,
          skippedCount,
          detail
        }
      } catch (error: any) {
        const message = error?.message || String(error)
        recordAndBroadcastTrace({
          phase: 'verify',
          summary: '自动添加微信好友失败',
          outcome: { status: 'fail', detail: message }
        })
        getTraceRecorder().endSession()
        wechatFriendAutomation = null
        updateWechatFriendStatus({
          stage: 'failed',
          account: lastCustomer?.wechat,
          detail: message
        })
        logWechatFriend('error', `自动添加好友失败：${message}`)
        return { success: false, stage: 'failed', customer: lastCustomer, error: message }
      }
    }
  )

  // 立即中断当前添加流程：设置停止标志并中断正在执行的自动化。
  ipcMain.handle('wechatFriend:stop', async () => {
    if (wechatFriendStatus.stage === 'preparing' || wechatFriendStatus.stage === 'sending') {
      wechatFriendStopRequested = true
      wechatFriendAutomation?.stop()
      logWechatFriend('skip', '已请求立即停止，正在中断当前操作')
    }
    return { success: true }
  })

  // ── Runtime / Session IPC（沿用 legacy engine:* 通道名） ──
  ipcMain.handle('engine:start', async (_event, config) => {
    const result = await startEngineCore(config)
    if (result.ok) return { success: true }
    return { success: false, error: result.message || result.reason }
  })

  ipcMain.handle('engine:stop', async (_event, reason?: string) => {
    const result = await stopEngineCore(reason || 'ipc_stop')
    if (result.ok) return { success: true }
    return { success: false, error: result.message || result.reason }
  })

  ipcMain.handle('engine:status', async () => {
    return { running: runtime?.isRunning() ?? false }
  })

  ipcMain.handle('engine:updateConfig', async (_event, config) => {
    const settings = normalizeSettings(config || settingsStore.store)
    if (runtimeDevice) {
      // setApiKey 在 BoxSelectDevice 上是 no-op，对 RPADevice 才生效。
      runtimeDevice.setApiKey(
        settings.vision.apiKey,
        settings.vision.model,
        settings.vision.baseURL
      )
      runtimeDevice.setAppType(settings.appType)
    }
    if (runtime) {
      runtime.updateAppType(settings.appType)
    }
    return { success: true }
  })

  ipcMain.handle('engine:testConnection', async (_event, config) => {
    const settings = normalizeSettings(settingsStore.store)
    const apiKey = config?.apiKey || settings.vision.apiKey
    const model = config?.model || settings.vision.model
    const baseURL = config?.baseURL || settings.vision.baseURL
    if (!apiKey) return { success: false, error: '请先在设置中填写视觉接口密钥' }
    if (!model) return { success: false, error: '请先在设置中填写视觉模型ID' }
    if (!baseURL) return { success: false, error: '请先在设置中填写视觉服务地址' }
    const client = new AIClient({
      apiKey,
      model,
      baseURL
    })
    return client.testConnection()
  })

  // ── Capture / 框选向导 IPC ──

  ipcMain.handle(
    'capture:openSetupWizard',
    async (_event, args: { appType: AppType; steps?: WizardStepKey[] }) => {
      const settings = normalizeSettings(settingsStore.store)
      const appType = coerceAppType(args?.appType)
      const prefill = settings.capture[appType]?.regions ?? null

      const result = await runBoxSelectWizard({ appType, steps: args?.steps, prefill })
      if (!result.ok || !result.regions) {
        return { success: false, reason: result.reason || 'cancelled' }
      }

      // 持久化区域到 settings.capture[appType]，但保留已有 strategy（默认 'auto'）
      const current = normalizeSettings(settingsStore.store)
      const next: AppSettings = {
        ...current,
        capture: {
          ...current.capture,
          [appType]: {
            strategy: current.capture[appType]?.strategy ?? 'auto',
            regions: result.regions
          }
        }
      }
      settingsStore.set(next as any)
      notifyCaptureRegionsUpdated(appType, result.regions)
      return { success: true, regions: result.regions }
    }
  )

  ipcMain.handle('capture:getRegions', async (_event, appType: AppType) => {
    const settings = normalizeSettings(settingsStore.store)
    return settings.capture[coerceAppType(appType)]?.regions ?? null
  })

  ipcMain.handle('capture:resetRegions', async (_event, appType: AppType) => {
    const current = normalizeSettings(settingsStore.store)
    const key = coerceAppType(appType)
    const next: AppSettings = {
      ...current,
      capture: {
        ...current.capture,
        [key]: { strategy: current.capture[key]?.strategy ?? 'auto', regions: null }
      }
    }
    settingsStore.set(next as any)
    notifyCaptureRegionsUpdated(key, null)
    return { success: true }
  })

  // IPC test
  ipcMain.on('ping', () => console.log('pong'))

  ipcMain.handle('capture-screen', async () => {
    try {
      const sources = await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: { width: 1920, height: 1080 }
      })
      if (sources && sources.length > 0) {
        return sources[0].thumbnail.toDataURL()
      }
      return null
    } catch (error) {
      console.error('Screen capture failed:', error)
      return null
    }
  })

  // ── 测试入口：VLM 并行 vs 串行 ──
  ipcMain.handle('test:vlm-parallel', async () => {
    const settings = normalizeSettings(settingsStore.store)
    const visionError = validateVisionSettings(settings)
    if (visionError) return { error: visionError }
    const { runVlmParallelTest } = await import('../core/rpa/tests/test-vlm-parallel')
    return await runVlmParallelTest(
      settings.vision.apiKey,
      'wechat',
      settings.vision.model,
      settings.vision.baseURL
    )
  })

  // ── Skill HTTP Server（OpenClaw 远程启动 / 暂停接入点） ──
  startSkillServer(skillEngineController)

  createWindow()

  app.on('activate', function () {
    // On macOS it's common to re-create a window in the app when the
    // dock icon is clicked and there are no other windows open.
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('before-quit', () => {
  stopSkillServer()
  wechatFriendAutomation?.cancel()
  wechatFriendAutomation = null
  getTraceRecorder().endSession()
})

// ── 引擎启动 / 暂停核心逻辑（IPC 与 Skill HTTP Server 共用） ──

async function startEngineCore(rawConfig?: any): Promise<SkillStartResult> {
  if (
    wechatFriendStatus.stage === 'preparing' ||
    wechatFriendStatus.stage === 'awaiting_confirmation' ||
    wechatFriendStatus.stage === 'sending'
  ) {
    return {
      ok: false,
      reason: 'friend_operation_active',
      message: '请先完成或取消添加好友操作'
    }
  }
  if (runtime?.isRunning()) {
    return { ok: false, reason: 'already_running', message: '引擎已在运行中' }
  }

  try {
    const settings = normalizeSettings(rawConfig || settingsStore.store)
    const appType: AppType = 'wechat'
    const startupStrategy = resolveSettingsStrategy(appType, settings)
    const needsVisionKey = startupStrategy === 'vlm'

    if (needsVisionKey) {
      if (!settings.vision.apiKey) {
        return { ok: false, reason: 'no_vision_key', message: '请先填写视觉接口密钥' }
      }
      if (!settings.vision.model) {
        return { ok: false, reason: 'no_vision_key', message: '请先填写视觉模型ID' }
      }
      if (!settings.vision.baseURL) {
        return { ok: false, reason: 'no_vision_key', message: '请先填写视觉服务地址' }
      }
    }

    // 回复模型与视觉定位模型使用独立配置；仅为旧配置兼容，在回复密钥为空时回退到视觉密钥。
    // 优先使用当前启用的本地智能体配置；无本地智能体时回退到旧版 chatProvider 配置。
    const replyConfig = resolveReplyConfig(settings)
    let provider
    if (!settings.chatProvider.installed) {
      const effectiveConfig = {
        ...replyConfig,
        apiKey: replyConfig.apiKey || settings.vision.apiKey
      }
      const loaded = await loadBuiltinDoubaoProvider(effectiveConfig)
      provider = loaded.provider
    } else {
      const installedManifest = await getInstalledProviderManifest(settings.chatProvider.installed)
      const isDoubao = settings.chatProvider.installed.id === BUILTIN_DOUBAO_PROVIDER_ID
      const effectiveConfig = isDoubao
        ? {
            ...replyConfig,
            apiKey: replyConfig.apiKey || settings.vision.apiKey
          }
        : settings.chatProvider.config
      const required = installedManifest?.configSchema?.required || []
      const missing = required.find((key) => {
        const value = effectiveConfig?.[key]
        return value === undefined || value === null || value === ''
      })
      if (missing) {
        return {
          ok: false,
          reason: 'missing_required_field',
          message: `缺少必填配置: ${missing}`
        }
      }

      const loaded = await loadInstalledProvider(settings.chatProvider.installed, effectiveConfig)
      provider = loaded.provider
    }

    const mainWindow = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed()) ?? null
    const log = (type: 'thinking' | 'reply' | 'skip' | 'error', content: string): void => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('engine:log', { type, content })
      }
    }

    let device: DesktopDevice
    let strategy: CaptureStrategy
    try {
      const built = await buildDevice(appType, settings, settings.vision.apiKey, log)
      device = built.device
      strategy = built.strategy
    } catch (err: any) {
      const message = err?.message || String(err)
      if (message === 'user_cancelled_box_select_wizard') {
        return { ok: false, reason: 'wizard_cancelled', message: '已取消框选，引擎未启动' }
      }
      throw err
    }
    log('thinking', `已选用抓取策略：${strategy}`)
    runtimeDevice = device

    // ── 工作记忆：本次执行的所有步骤落成 work-trace 会话 ──
    const recorder = getTraceRecorder()
    recorder.startSession({
      appType,
      engineVersion: app.getVersion(),
      providerId: settings.chatProvider.installed?.id ?? BUILTIN_DOUBAO_PROVIDER_ID,
      model: replyConfig.model || settings.vision.model
    })

    const onTrace = (input: TraceStepInput): void => {
      const step = recorder.record(input)
      if (!step) return

      // 继承闭环：带经验引用的回复成功发送 → 卡片 used/success 计数
      const refs = step.reasoning?.memoryRefs
      if (step.phase === 'act' && step.action?.kind === 'send' && refs?.length) {
        getExperienceStore().recordUsage(refs, step.outcome?.status === 'ok')
      }

      // 实时推给工作记忆窗口
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) {
          win.webContents.send('trace:step', { sessionId: step.sessionId, step })
        }
      }
    }

    const channel = new GenericChannelSession(device)
    runtime = new RuntimeHost({
      appType,
      channel,
      provider,
      initialState: createInitialGenericChannelState(),
      onLog: log,
      onTrace,
      getMemoryCards: () => getExperienceStore().getActiveCardBriefs(),
      onSessionEnd: () => recorder.endSession()
    })

    runtime.startSession().catch((err: any) => {
      console.error('[Main] Runtime session error:', err)
    })

    notifyEngineStateChanged('running')

    return { ok: true }
  } catch (error: any) {
    return {
      ok: false,
      reason: 'engine_failed',
      message: error?.message || String(error)
    }
  }
}

async function stopEngineCore(stopReason: string): Promise<SkillPauseResult> {
  if (!runtime?.isRunning()) {
    return { ok: false, reason: 'not_running', message: '引擎未运行' }
  }
  try {
    await runtime.stopSession(stopReason)
    notifyEngineStateChanged('idle')
    return { ok: true }
  } catch (error: any) {
    return {
      ok: false,
      reason: 'pause_failed',
      message: error?.message || String(error)
    }
  }
}

/** 通知 Renderer 引擎状态变化（让 UI 在远程启停时同步切换） */
function notifyEngineStateChanged(status: 'running' | 'idle'): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send('engine:state', { status })
    }
  }
}

/** 通知 Renderer：某个 appType 的框选区域被向导/重置更新了，UI 上的 chip 立即重渲染。 */
function notifyCaptureRegionsUpdated(appType: AppType, regions: BoxRegions | null): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send('capture:regions-updated', { appType, regions })
    }
  }
}

/**
 * 选取实际生效的 capture strategy。
 * 用户在 settings 里给 appType 显式设置过策略，就用它；否则用全局默认；
 * 全局默认是 'auto' 时，wechat/wework 优先 VLM，其它直接 box-select。
 */
function resolveEffectiveStrategy(
  appType: AppType,
  perAppStrategy: CaptureStrategy,
  defaultStrategy: CaptureStrategy
): CaptureStrategy {
  const effective = perAppStrategy === 'auto' ? defaultStrategy : perAppStrategy
  if (effective === 'auto') {
    return isWechatLike(appType) ? 'vlm' : 'box-select'
  }
  return effective
}

function resolveSettingsStrategy(appType: AppType, settings: AppSettings): CaptureStrategy {
  const perApp = settings.capture[appType] ?? { strategy: 'auto' as CaptureStrategy, regions: null }
  return resolveEffectiveStrategy(appType, perApp.strategy, settings.defaultCaptureStrategy)
}

/**
 * 把 capture 配置 + strategy 解析成具体设备实例。
 * VLM 和 box-select 只决定"如何测量 LayoutCache"，后续运行统一消费 LayoutCache。
 * 本轮不做 VLM 失败自动 fallback；VLM 测量失败由 session bootstrap 报错停止。
 */
async function buildDevice(
  appType: AppType,
  settings: AppSettings,
  apiKey: string,
  log: (type: 'thinking' | 'reply' | 'skip' | 'error', content: string) => void
): Promise<{ device: DesktopDevice; strategy: CaptureStrategy }> {
  const perApp = settings.capture[appType] ?? { strategy: 'auto' as CaptureStrategy, regions: null }
  const effective = resolveSettingsStrategy(appType, settings)

  if (effective === 'vlm') {
    const rpa = new RPADevice()
    rpa.setAppType(appType)
    rpa.setApiKey(apiKey, settings.vision.model, settings.vision.baseURL)
    return { device: rpa, strategy: 'vlm' }
  }

  // box-select 路线：缺区域则拉向导
  let regions = perApp.regions
  if (!regions) {
    log('thinking', `首次配置 ${appType}：请框选 3 个关键区域`)
    const wizardResult = await runBoxSelectWizard({ appType, prefill: null })
    if (!wizardResult.ok || !wizardResult.regions) {
      throw new Error('user_cancelled_box_select_wizard')
    }
    regions = wizardResult.regions
    persistRegionsAndStickyStrategy(appType, regions, perApp.strategy)
  }
  return { device: new BoxSelectDevice(regions), strategy: 'box-select' }
}

/** 把向导产出的 regions 写回 settings，并保留当前策略配置。 */
function persistRegionsAndStickyStrategy(
  appType: AppType,
  regions: BoxRegions,
  strategy: CaptureStrategy
): void {
  const current = normalizeSettings(settingsStore.store)
  const next: AppSettings = {
    ...current,
    capture: {
      ...current.capture,
      [appType]: { strategy, regions }
    }
  }
  settingsStore.set(next as any)
  notifyCaptureRegionsUpdated(appType, regions)
}

const skillEngineController: SkillEngineController = {
  start: () => startEngineCore(),
  pause: () => stopEngineCore('skill_pause'),
  isRunning: () => runtime?.isRunning() ?? false
}

// In this file you can include the rest of your app's specific main process
// code. You can also put them in separate files and require them here.

// 二创版本仅开放微信。保留 AppType 联合类型是为了降低后续 Pull 上游时的冲突，
// 但所有外部配置在进入运行时前都会被强制归一化为 wechat。
const VALID_APP_TYPES: AppType[] = ['wechat']
const VALID_CAPTURE_STRATEGIES: CaptureStrategy[] = ['auto', 'vlm', 'box-select']

function coerceAppType(_raw: unknown): AppType {
  return 'wechat'
}

function coerceStrategy(raw: unknown, fallback: CaptureStrategy = 'auto'): CaptureStrategy {
  return typeof raw === 'string' && (VALID_CAPTURE_STRATEGIES as string[]).includes(raw)
    ? (raw as CaptureStrategy)
    : fallback
}

function coerceRect(raw: unknown): BoxRegions['contactList'] | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const x = Number(r.x),
    y = Number(r.y),
    w = Number(r.width),
    h = Number(r.height)
  if (![x, y, w, h].every((n) => Number.isFinite(n))) return null
  return { x, y, width: w, height: h }
}

function coerceRegions(raw: unknown): BoxRegions | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const contactList = coerceRect(r.contactList)
  const chatMain = coerceRect(r.chatMain)
  const inputBox = coerceRect(r.inputBox)
  if (!contactList || !chatMain || !inputBox) return null
  return {
    contactList,
    chatMain,
    inputBox,
    unreadIndicator: coerceRect(r.unreadIndicator),
    displayId: typeof r.displayId === 'number' ? r.displayId : undefined,
    scaleFactor: typeof r.scaleFactor === 'number' ? r.scaleFactor : undefined,
    capturedAt: typeof r.capturedAt === 'number' ? r.capturedAt : Date.now()
  }
}

function normalizeCapture(raw: unknown): Partial<Record<AppType, PerAppCapture>> {
  const out: Partial<Record<AppType, PerAppCapture>> = {}
  if (!raw || typeof raw !== 'object') return out
  for (const key of VALID_APP_TYPES) {
    const value = (raw as Record<string, unknown>)[key]
    if (!value || typeof value !== 'object') continue
    const v = value as Record<string, unknown>
    out[key] = {
      strategy: coerceStrategy(v.strategy),
      regions: coerceRegions(v.regions)
    }
  }
  return out
}

/** 校验视觉配置是否完整，返回缺失项提示；完整时返回 null */
function validateVisionSettings(settings: AppSettings): string | null {
  if (!settings.vision.apiKey) return '请先在设置中填写视觉接口密钥'
  if (!settings.vision.model) return '请先在设置中填写视觉模型ID'
  if (!settings.vision.baseURL) return '请先在设置中填写视觉服务地址'
  return null
}

function normalizeSettings(raw: any): AppSettings {
  const oldApiKey = typeof raw?.apiKey === 'string' ? raw.apiKey : ''
  const oldModel = typeof raw?.model === 'string' && raw.model ? raw.model : ''
  const oldSystemPrompt = typeof raw?.systemPrompt === 'string' ? raw.systemPrompt : ''
  const rawProviderConfig =
    raw?.chatProvider?.config && typeof raw.chatProvider.config === 'object'
      ? { ...raw.chatProvider.config }
      : {}

  // Keep arbitrary provider config keys, and only backfill legacy volcengine fields for old persisted settings.
  if (rawProviderConfig.apiKey === undefined && oldApiKey) {
    rawProviderConfig.apiKey = oldApiKey
  }
  if (rawProviderConfig.model === undefined && oldModel) {
    rawProviderConfig.model = oldModel
  }
  if (rawProviderConfig.systemPrompt === undefined && oldSystemPrompt) {
    rawProviderConfig.systemPrompt = oldSystemPrompt
  }

  const rawAgents = Array.isArray(raw?.agents) ? raw.agents : []
  const agents = rawAgents.map((a) => normalizeAgent(a)).filter((a): a is LocalAgent => a !== null)
  const activeAgentId =
    typeof raw?.activeAgentId === 'string' && agents.some((a) => a.id === raw.activeAgentId)
      ? raw.activeAgentId
      : agents[0]?.id || ''

  return {
    locale: raw?.locale === 'en' ? 'en' : 'zh',
    appType: coerceAppType(raw?.appType),
    vision: {
      apiKey: raw?.vision?.apiKey || oldApiKey || '',
      model:
        typeof raw?.vision?.model === 'string' && raw.vision.model.trim()
          ? raw.vision.model.trim()
          : '',
      baseURL:
        typeof raw?.vision?.baseURL === 'string' && raw.vision.baseURL.trim()
          ? raw.vision.baseURL.trim()
          : ''
    },
    chatProvider: {
      manifestUrl: raw?.chatProvider?.manifestUrl || raw?.providerManifestUrl || '',
      installed: raw?.chatProvider?.installed || null,
      config: rawProviderConfig
    },
    agents,
    activeAgentId,
    customerApiUrl:
      typeof raw?.customerApiUrl === 'string' && raw.customerApiUrl.trim()
        ? raw.customerApiUrl.trim()
        : 'http://192.168.8.94:8500',
    friendAddIntervalMinutes:
      typeof raw?.friendAddIntervalMinutes === 'number' &&
      Number.isFinite(raw.friendAddIntervalMinutes) &&
      raw.friendAddIntervalMinutes >= 0
        ? Math.floor(raw.friendAddIntervalMinutes)
        : 0,
    defaultCaptureStrategy: coerceStrategy(raw?.defaultCaptureStrategy, 'auto'),
    capture: normalizeCapture(raw?.capture)
  }
}

function normalizeAgent(raw: any): LocalAgent | null {
  if (!raw || typeof raw !== 'object') return null
  const id = typeof raw.id === 'string' ? raw.id.trim() : ''
  const name = typeof raw.name === 'string' ? raw.name.trim() : ''
  if (!id || !name) return null
  const config = raw.config && typeof raw.config === 'object' ? raw.config : {}
  return {
    id,
    name,
    config: {
      apiKey: typeof config.apiKey === 'string' ? config.apiKey : '',
      model: typeof config.model === 'string' ? config.model : '',
      baseURL: typeof config.baseURL === 'string' ? config.baseURL : '',
      systemPrompt: typeof config.systemPrompt === 'string' ? config.systemPrompt : ''
    }
  }
}

/** 首次运行时，把旧版单一 chatProvider 配置迁移为一个默认本地智能体。 */
function seedLocalAgents(): void {
  const current = normalizeSettings(settingsStore.store)
  if (current.agents.length > 0) return

  // 仅当未安装第三方 bundle（installed 为空）时，旧配置才是内置 doubao 的配置，可直接迁移。
  const legacy = current.chatProvider.installed == null ? current.chatProvider.config || {} : {}
  const agent: LocalAgent = {
    id: 'doubao',
    name: '豆包 Seed',
    config: {
      apiKey: (typeof legacy.apiKey === 'string' && legacy.apiKey) || current.vision.apiKey || '',
      model:
        (typeof legacy.model === 'string' && legacy.model.trim()) || DEFAULT_AGENT_CONFIG.model,
      baseURL:
        (typeof legacy.baseURL === 'string' && legacy.baseURL.trim()) ||
        DEFAULT_AGENT_CONFIG.baseURL,
      systemPrompt: typeof legacy.systemPrompt === 'string' ? legacy.systemPrompt : ''
    }
  }

  settingsStore.set({
    ...current,
    agents: [agent],
    activeAgentId: agent.id
  } as any)
}

/** 返回当前启用本地智能体的配置；无本地智能体时回退到旧版 chatProvider 配置。 */
function resolveReplyConfig(settings: AppSettings): Record<string, any> {
  const active = settings.agents.find((a) => a.id === settings.activeAgentId) || settings.agents[0]
  if (active) return { ...active.config }
  return { ...settings.chatProvider.config }
}

function withSchemaDefaults(
  schema: { properties: Record<string, { default?: unknown }> },
  current: Record<string, any>
): Record<string, any> {
  const next = { ...current }
  for (const [key, field] of Object.entries(schema.properties || {})) {
    if (next[key] === undefined && field.default !== undefined) {
      next[key] = field.default
    }
  }
  return next
}
