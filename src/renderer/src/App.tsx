import { useState, useCallback, useRef, useEffect, useMemo } from 'react'
import { t } from './i18n'
import logoUrl from './assets/logo.png'
import MemoryWindow from './MemoryWindow'
import './index.css'

interface LogEntry {
  time: string
  type: 'thinking' | 'reply' | 'skip' | 'error'
  content: string
}

type EngineStatus = 'idle' | 'running' | 'error'
type SettingsSection = 'base' | 'agent'
type OperationMode = 'monitor' | 'add-friend'
type AppType = 'wechat'

type CaptureStrategy = 'auto' | 'vlm' | 'box-select'

interface ScreenRect {
  x: number
  y: number
  width: number
  height: number
}

interface BoxRegions {
  contactList: ScreenRect
  chatMain: ScreenRect
  inputBox: ScreenRect
  unreadIndicator: ScreenRect | null
  displayId?: number
  scaleFactor?: number
  capturedAt: number
}

interface WechatFriendOperationStatus {
  stage:
    | 'idle'
    | 'preparing'
    | 'awaiting_confirmation'
    | 'sending'
    | 'completed'
    | 'cancelled'
    | 'failed'
  account?: string
  sessionId?: string | null
  detail?: string
}

interface ProviderSchemaField {
  type: 'string' | 'password' | 'select' | 'boolean'
  title: string
  default?: string | boolean
  enum?: string[]
}

interface ProviderManifest {
  apiVersion: 1
  id: string
  name: string
  version: string
  entry: string
  capabilities: ['chat']
  configSchema: {
    type: 'object'
    properties: Record<string, ProviderSchemaField>
    required?: string[]
  }
}

interface InstalledProviderInfo {
  id: string
  name: string
  version: string
  entryFile: string
  installedAt: string
}

type ProviderConfigFieldType = 'text' | 'password' | 'url' | 'select' | 'textarea'

interface ProviderConfigField {
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

interface ProviderCatalogItem {
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

interface ProviderHubCache {
  sourceUrl: string
  fetchedAt: string
  providers: ProviderCatalogItem[]
}

interface ProviderHubResult {
  success: boolean
  error?: string
  catalog?: ProviderHubCache | null
}

interface PerAppCapture {
  strategy: CaptureStrategy
  regions: BoxRegions | null
}

interface AppSettings {
  locale: 'zh' | 'en'
  appType: AppType
  vision: {
    apiKey: string
  }
  chatProvider: {
    manifestUrl: string
    installed: InstalledProviderInfo | null
    config: Record<string, any>
  }
  customerApiUrl: string
  defaultCaptureStrategy: CaptureStrategy
  capture: Partial<Record<AppType, PerAppCapture>>
}

const VERIFICATION_MESSAGES: Array<{ id: string; label: string; message: string }> = [
  {
    id: 'default',
    label: '直播增量（默认话术）',
    message: '您好：我这边是直播增量部门的，无需投入任何成本，每月额外多增50%的销量，可以认识聊聊'
  }
]

const BUILTIN_PROVIDER_CATALOG: ProviderCatalogItem[] = [
  {
    id: 'doubao',
    name: '豆包 Seed',
    description:
      '内置 OpenAI 兼容回复 Provider，可独立配置 API Key、Base URL 和支持图片输入的模型。',
    version: '1.0.0',
    manifestUrl: 'builtin://doubao',
    capabilities: ['chat'],
    configSchema: {
      fields: [
        {
          key: 'apiKey',
          label: 'API Key',
          type: 'password',
          required: true,
          placeholder: '输入火山方舟 API Key'
        },
        {
          key: 'model',
          label: '模型',
          type: 'text',
          required: true,
          defaultValue: 'doubao-seed-2-0-lite-260215',
          hint: '回复流程会把聊天截图发送给模型，因此模型必须支持图片输入。'
        },
        {
          key: 'baseURL',
          label: 'Base URL',
          type: 'url',
          required: true,
          placeholder: 'https://ark.cn-beijing.volces.com/api/v3',
          defaultValue: 'https://ark.cn-beijing.volces.com/api/v3',
          hint: '支持填写 API 根地址，或直接填写完整的 /chat/completions 地址。'
        },
        {
          key: 'systemPrompt',
          label: '系统提示词',
          type: 'textarea',
          placeholder: '你是一个微信自动回复助手。根据截图中的聊天内容，生成合适的回复...'
        }
      ]
    }
  }
]

const PlayIcon = () => (
  <svg viewBox="0 0 24 24" fill="currentColor">
    <path d="M8 5.14v14l11-7-11-7z" />
  </svg>
)

const StopIcon = () => (
  <svg viewBox="0 0 24 24" fill="currentColor">
    <rect x="6" y="6" width="12" height="12" rx="2" />
  </svg>
)

const GearIcon = () => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.8"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
  </svg>
)

// 工作记忆 — 时钟+轨迹点图标
const MemoryIcon = (): React.JSX.Element => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.8"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M3 12a9 9 0 1 0 3-6.7" />
    <path d="M3 4v5h5" />
    <path d="M12 7v5l3 3" />
  </svg>
)

const RefreshIcon = (): React.JSX.Element => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M21 12a9 9 0 0 1-15.1 6.6" />
    <path d="M3 12A9 9 0 0 1 18.1 5.4" />
    <path d="M18 2v4h-4" />
    <path d="M6 22v-4h4" />
  </svg>
)

function App() {
  const windowKind = new URLSearchParams(window.location.search).get('window')
  const [status, setStatus] = useState<EngineStatus>('idle')
  const [operationMode, setOperationMode] = useState<OperationMode>('monitor')

  // Sync UI status with engine state changes triggered out-of-band
  // (e.g. remote OpenClaw start/pause via the local skill HTTP server).
  useEffect(() => {
    const cleanup = window.electron?.on('engine:state', (data: { status: 'running' | 'idle' }) => {
      setStatus(data.status === 'running' ? 'running' : 'idle')
    })
    return cleanup
  }, [])

  if (windowKind === 'settings') {
    return (
      <div className="app settings-window">
        <SettingsWindow />
        <Toast />
      </div>
    )
  }

  if (windowKind === 'memory') {
    return (
      <div className="app settings-window">
        <MemoryWindow />
        <Toast />
      </div>
    )
  }

  return (
    <div className="app">
      <header className="app-header">
        <img src={logoUrl} alt="SightFlow" className="app-logo" />
      </header>

      <div className="app-content">
        <ControlPanel
          status={status}
          setStatus={setStatus}
          operationMode={operationMode}
          setOperationMode={setOperationMode}
        />
      </div>

      <BottomBar status={status} setStatus={setStatus} operationMode={operationMode} />

      <Toast />
    </div>
  )
}

function ControlPanel({
  status,
  setStatus,
  operationMode,
  setOperationMode
}: {
  status: EngineStatus
  setStatus: (s: EngineStatus) => void
  operationMode: OperationMode
  setOperationMode: (mode: OperationMode) => void
}) {
  const [logs, setLogs] = useState<LogEntry[]>([])
  const [verificationId, setVerificationId] = useState(VERIFICATION_MESSAGES[0].id)
  const [friendAddMode, setFriendAddMode] = useState<'single' | 'continuous'>('single')
  const [friendStatus, setFriendStatus] = useState<WechatFriendOperationStatus>({ stage: 'idle' })
  const logRef = useRef<HTMLDivElement>(null)

  const addLog = useCallback((type: LogEntry['type'], content: string) => {
    const time = new Date().toLocaleTimeString('en-US', { hour12: false })
    setLogs((prev) => [...prev.slice(-99), { time, type, content }])
  }, [])

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight
  }, [logs])

  useEffect(() => {
    const cleanup = window.electron?.on('engine:log', (data: { type: string; content: string }) => {
      addLog(data.type as LogEntry['type'], data.content)
      if (data.type === 'error' && data.content.includes('引擎无法启动')) setStatus('error')
    })
    return cleanup
  }, [addLog, setStatus])

  useEffect(() => {
    void (async () => {
      const current = (await window.electron?.invoke('wechatFriend:getStatus')) as
        | WechatFriendOperationStatus
        | undefined
      if (current) setFriendStatus(current)
    })()
    const cleanup = window.electron?.on('wechatFriend:state', (next: WechatFriendOperationStatus) =>
      setFriendStatus(next)
    )
    return cleanup
  }, [])

  const friendBusy = friendStatus.stage === 'preparing' || friendStatus.stage === 'sending'
  const awaitingConfirmation = friendStatus.stage === 'awaiting_confirmation'
  const operationLocked = status === 'running' || friendBusy || awaitingConfirmation

  const handleAutoAddFriend = useCallback(async () => {
    const option =
      VERIFICATION_MESSAGES.find((item) => item.id === verificationId) || VERIFICATION_MESSAGES[0]
    const result = (await window.electron?.invoke('wechatFriend:autoAdd', {
      verificationMessage: option.message,
      mode: friendAddMode
    })) as
      | {
          success: boolean
          stage: string
          customer?: { name: string }
          addedCount?: number
          detail?: string
          error?: string
        }
      | undefined
    if (result?.success) {
      const addedCount = result.addedCount || 0
      if (addedCount > 1) {
        showToast(`已发送 ${addedCount} 个好友申请`, 'success')
      } else {
        showToast(
          result.customer ? `已发送好友申请：${result.customer.name}` : result.detail || '已完成',
          'success'
        )
      }
    } else {
      showToast(result?.error || '自动添加好友失败', 'error')
    }
  }, [verificationId, friendAddMode])

  const handleStopAutoAdd = useCallback(async () => {
    await window.electron?.invoke('wechatFriend:stop')
  }, [])

  const statusLabel =
    status === 'running'
      ? t('status.running')
      : status === 'error'
        ? t('status.error')
        : t('status.idle')

  const friendStatusText: Record<WechatFriendOperationStatus['stage'], string> = {
    idle: '尚未开始',
    preparing: '正在取号并准备微信界面',
    awaiting_confirmation: '已填写，等待你确认发送',
    sending: '正在自动添加并发送申请',
    completed: '好友申请已发送并回写',
    cancelled: '已取消发送',
    failed: '操作失败'
  }

  return (
    <div className="fade-in">
      <div className={`status-indicator ${status}`}>
        <div className={`status-dot ${status}`} />
        <span className="status-text">{statusLabel}</span>
      </div>

      <div className="card wechat-target-card">
        <div className="card-title">目标应用</div>
        <div className="wechat-target-row">
          <div className="wechat-logo-mark">微</div>
          <div className="wechat-target-copy">
            <strong>微信</strong>
            <span>自动识别（VLM） · 拟人鼠标移动与点击</span>
          </div>
          <span className="wechat-only-badge">仅微信</span>
        </div>
        <div className="form-hint wechat-target-hint">此二创版本已在界面和运行时禁用其他平台。</div>
      </div>

      <div className="operation-tabs" role="tablist" aria-label="微信操作">
        <button
          className={`operation-tab ${operationMode === 'monitor' ? 'active' : ''}`}
          onClick={() => setOperationMode('monitor')}
          disabled={operationLocked && operationMode !== 'monitor'}
        >
          消息监控与回复
        </button>
        <button
          className={`operation-tab ${operationMode === 'add-friend' ? 'active' : ''}`}
          onClick={() => setOperationMode('add-friend')}
          disabled={operationLocked && operationMode !== 'add-friend'}
        >
          添加微信好友
        </button>
      </div>

      {operationMode === 'add-friend' && (
        <div className="card friend-operation-form">
          <div className="card-title">添加微信好友（自动取号）</div>
          <div className="friend-operation-notice">
            系统会自动从后端取「待添加」客户，搜索并发送好友申请，备注自动设为“名字-渠道”，发送后自动回写状态并记录当前微信号。
          </div>

          <div className="form-group">
            <label className="form-label">添加模式</label>
            <div className="friend-mode-toggle" role="radiogroup" aria-label="添加模式">
              <button
                type="button"
                className={`friend-mode-option ${friendAddMode === 'single' ? 'active' : ''}`}
                onClick={() => setFriendAddMode('single')}
                disabled={friendBusy || awaitingConfirmation}
                role="radio"
                aria-checked={friendAddMode === 'single'}
              >
                一次添加一个
              </button>
              <button
                type="button"
                className={`friend-mode-option ${friendAddMode === 'continuous' ? 'active' : ''}`}
                onClick={() => setFriendAddMode('continuous')}
                disabled={friendBusy || awaitingConfirmation}
                role="radio"
                aria-checked={friendAddMode === 'continuous'}
              >
                持续添加不停歇
              </button>
            </div>
            <div className="form-hint">
              {friendAddMode === 'single'
                ? '每次只取一个「待添加」客户，添加完成后自动停止。'
                : '连续取号并逐个添加，直到没有「待添加」客户或手动点击停止。'}
            </div>
          </div>

          <div className="form-group">
            <label className="form-label" htmlFor="friend-verification">
              验证消息话术
            </label>
            <select
              id="friend-verification"
              className="form-input"
              value={verificationId}
              onChange={(event) => setVerificationId(event.target.value)}
              disabled={friendBusy || awaitingConfirmation}
            >
              {VERIFICATION_MESSAGES.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.label}
                </option>
              ))}
            </select>
            <div className="form-hint">
              当前话术：{VERIFICATION_MESSAGES.find((item) => item.id === verificationId)?.message}
            </div>
          </div>

          <div className={`friend-operation-status stage-${friendStatus.stage}`}>
            <span className="friend-status-dot" />
            <div>
              <strong>{friendStatusText[friendStatus.stage]}</strong>
              {friendStatus.detail && <span>{friendStatus.detail}</span>}
            </div>
          </div>

          <div className="friend-actions">
            {friendBusy && friendAddMode === 'continuous' ? (
              <button className="btn btn-secondary btn-large" onClick={handleStopAutoAdd}>
                停止添加
              </button>
            ) : (
              <button
                className="btn btn-primary btn-large"
                onClick={handleAutoAddFriend}
                disabled={friendBusy || awaitingConfirmation || status === 'running'}
              >
                {friendBusy
                  ? '正在自动添加...'
                  : friendAddMode === 'continuous'
                    ? '开始持续添加'
                    : '开始自动添加'}
              </button>
            )}
          </div>
        </div>
      )}

      <div className="card">
        <div className="card-title">{t('control.log')}</div>
        <div className="message-log" ref={logRef}>
          {logs.length === 0 ? (
            <div className="message-log-empty">{t('control.log.empty')}</div>
          ) : (
            logs.map((entry, i) => (
              <div className="log-entry" key={i}>
                <span className="log-time">{entry.time}</span>
                <span className={`log-type ${entry.type}`}>
                  {t(`control.log.${entry.type}` as never)}
                </span>
                <span>{entry.content}</span>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  )
}

function BottomBar({
  status,
  setStatus,
  operationMode
}: {
  status: EngineStatus
  setStatus: (s: EngineStatus) => void
  operationMode: OperationMode
}) {
  const handleStart = useCallback(async () => {
    const settings = (await window.electron?.invoke('settings:getAll')) as AppSettings | undefined
    if (!settings) return

    if (!settings.vision?.apiKey) {
      showToast(t('control.start.novisionkey'), 'error')
      return
    }

    const providerInfo = (await window.electron?.invoke('provider:getInstalled')) as {
      manifest: ProviderManifest | null
      isBuiltinDefault?: boolean
    }
    const required = providerInfo?.manifest?.configSchema?.required || []
    const isBuiltinDoubao = providerInfo?.isBuiltinDefault === true
    const missing = required.find((key) => {
      const value =
        isBuiltinDoubao && key === 'apiKey'
          ? settings.chatProvider.config?.apiKey || settings.vision.apiKey
          : settings.chatProvider.config?.[key]
      return value === undefined || value === null || value === ''
    })
    if (missing) {
      showToast(`${t('control.start.missingProviderField')}: ${missing}`, 'error')
      return
    }

    const result = await window.electron?.invoke('engine:start', settings)
    if (result?.success) {
      setStatus('running')
      showToast(t('toast.engineStarted'), 'success')
    } else {
      setStatus('error')
      showToast(result?.error || t('toast.startFailed'), 'error')
    }
  }, [setStatus])

  const handleStop = useCallback(async () => {
    await window.electron?.invoke('engine:stop')
    setStatus('idle')
    showToast(t('toast.engineStopped'), 'success')
  }, [setStatus])

  const running = status === 'running'

  return (
    <div className="bottom-bar">
      {operationMode === 'monitor' ? (
        running ? (
          <button className="bottom-btn bottom-btn-stop" onClick={handleStop}>
            <StopIcon />
            {t('control.stop')}
          </button>
        ) : (
          <button className="bottom-btn bottom-btn-play" onClick={handleStart}>
            <PlayIcon />
            {t('control.start')}
          </button>
        )
      ) : (
        <button className="bottom-btn bottom-btn-operation" disabled>
          请使用上方好友操作
        </button>
      )}
      <button
        className="bottom-btn bottom-btn-settings"
        onClick={() => window.electron?.invoke('memory:open')}
        title="工作记忆"
      >
        <MemoryIcon />
      </button>
      <button
        className="bottom-btn bottom-btn-settings"
        onClick={() => window.electron?.invoke('settings:open')}
        title="设置"
      >
        <GearIcon />
      </button>
    </div>
  )
}

function SettingsWindow(): React.JSX.Element {
  const [section, setSection] = useState<SettingsSection>('base')

  return (
    <div className="settings-shell">
      <aside className="settings-sidebar">
        <div className="settings-sidebar-brand">
          <img src={logoUrl} alt="SightFlow" className="app-logo" />
          <span>设置</span>
        </div>
        <button
          className={`settings-nav-item ${section === 'base' ? 'active' : ''}`}
          onClick={() => setSection('base')}
        >
          基础配置
        </button>
        <button
          className={`settings-nav-item ${section === 'agent' ? 'active' : ''}`}
          onClick={() => setSection('agent')}
        >
          智能体
        </button>
      </aside>

      <main className="settings-main">
        {section === 'base' ? <SettingsPanel /> : <AgentPanel />}
      </main>
    </div>
  )
}

function SettingsPanel() {
  const [visionApiKey, setVisionApiKey] = useState('')
  const [customerApiUrl, setCustomerApiUrl] = useState('')
  const [testing, setTesting] = useState(false)

  useEffect(() => {
    const load = async () => {
      const settings = (await window.electron?.invoke('settings:getAll')) as AppSettings | undefined
      if (settings) {
        setVisionApiKey(settings.vision?.apiKey || '')
        setCustomerApiUrl(settings.customerApiUrl || '')
      }
    }

    void load()
  }, [])

  const handleSaveVision = useCallback(async () => {
    const payload: Partial<AppSettings> = {
      vision: { apiKey: visionApiKey },
      customerApiUrl
    }
    await window.electron?.invoke('settings:set', payload)
    await window.electron?.invoke('engine:updateConfig', {
      ...((await window.electron?.invoke('settings:getAll')) as AppSettings),
      ...payload,
      vision: { apiKey: visionApiKey }
    })
    showToast(t('settings.saved'), 'success')
  }, [visionApiKey, customerApiUrl])

  const handleTestConnection = useCallback(async () => {
    if (!visionApiKey) return
    setTesting(true)
    try {
      const result = await window.electron?.invoke('engine:testConnection', {
        apiKey: visionApiKey
      })
      if (result?.success) {
        showToast(t('settings.testConnection.success'), 'success')
      } else {
        showToast(`${t('settings.testConnection.fail')}: ${result?.error || ''}`, 'error')
      }
    } catch (e: any) {
      showToast(`${t('settings.testConnection.fail')}: ${e.message}`, 'error')
    } finally {
      setTesting(false)
    }
  }, [visionApiKey])

  return (
    <div className="settings-page slide-up">
      <div className="settings-page-header">
        <div>
          <h1>基础配置</h1>
          <p>维护桌面端运行所需的基础参数。</p>
        </div>
      </div>

      <div className="card base-settings-card">
        <div className="card-title">{t('settings.vision')}</div>

        <div className="form-group">
          <label className="form-label">{t('settings.visionApiKey')}</label>
          <input
            className="form-input"
            type="password"
            value={visionApiKey}
            onChange={(e) => setVisionApiKey(e.target.value)}
            placeholder={t('settings.visionApiKey.placeholder')}
            autoComplete="off"
          />
          <div className="form-hint">{t('settings.visionApiKey.hint')}</div>
        </div>

        <div className="form-group">
          <label className="form-label">{t('settings.visionModel')}</label>
          <input className="form-input" value="doubao-seed-2-0-lite-260215" disabled />
        </div>

        <div className="form-group">
          <label className="form-label">{t('settings.visionBaseUrl')}</label>
          <input className="form-input" value="https://ark.cn-beijing.volces.com/api/v3" disabled />
        </div>

        <div className="form-group">
          <label className="form-label">客户记录后端地址</label>
          <input
            className="form-input"
            type="url"
            value={customerApiUrl}
            onChange={(e) => setCustomerApiUrl(e.target.value)}
            placeholder="http://192.168.8.94:8500"
            autoComplete="off"
          />
          <div className="form-hint">自动添加好友时的取号与状态回写地址（如 http://192.168.8.94:8500）</div>
        </div>

        <div style={{ display: 'flex', gap: 8 }}>
          <button
            className="btn btn-secondary"
            onClick={handleTestConnection}
            disabled={!visionApiKey || testing}
          >
            {testing ? t('settings.testConnection.testing') : t('settings.testConnection')}
          </button>
          <button className="btn btn-primary" onClick={handleSaveVision} style={{ flex: 1 }}>
            {t('settings.saveVision')}
          </button>
        </div>
      </div>
    </div>
  )
}

function AgentPanel(): React.JSX.Element {
  const [catalog, setCatalog] = useState<ProviderCatalogItem[]>(BUILTIN_PROVIDER_CATALOG)
  const [selectedId, setSelectedId] = useState(BUILTIN_PROVIDER_CATALOG[0]?.id || '')
  const [activeId, setActiveId] = useState('doubao')
  const [providerDrafts, setProviderDrafts] = useState<Record<string, Record<string, string>>>({})
  const [currentSettings, setCurrentSettings] = useState<AppSettings | null>(null)
  const [loadingCatalog, setLoadingCatalog] = useState(false)
  const [updatingCatalog, setUpdatingCatalog] = useState(false)
  const selectedProvider = catalog.find((provider) => provider.id === selectedId) || catalog[0]

  const loadSettingsAndCatalog = useCallback(async (forceUpdate: boolean) => {
    setLoadingCatalog(!forceUpdate)
    setUpdatingCatalog(forceUpdate)
    try {
      const [settings, result] = await Promise.all([
        window.electron?.invoke('settings:getAll') as Promise<AppSettings | undefined>,
        window.electron?.invoke(
          forceUpdate ? 'providerHub:update' : 'providerHub:getCatalog'
        ) as Promise<ProviderHubResult>
      ])

      const nextCatalog = mergeProviderCatalog(result?.catalog?.providers || [])
      const nextActiveId = settings?.chatProvider?.installed?.id || 'doubao'
      setCatalog(nextCatalog)
      setCurrentSettings(settings || null)
      setActiveId(nextActiveId)
      setSelectedId(
        (current) =>
          current || nextActiveId || BUILTIN_PROVIDER_CATALOG[0]?.id || nextCatalog[0]?.id || ''
      )
      setProviderDrafts((prev) => ({
        ...prev,
        doubao: {
          ...getProviderDefaults(BUILTIN_PROVIDER_CATALOG[0]),
          ...(prev.doubao || {}),
          ...(!settings?.chatProvider?.installed ? settings?.chatProvider?.config || {} : {}),
          apiKey: prev.doubao?.apiKey || settings?.vision?.apiKey || ''
        },
        [nextActiveId]: {
          ...getProviderDefaults(nextCatalog.find((provider) => provider.id === nextActiveId)),
          ...(prev[nextActiveId] || {}),
          ...(settings?.chatProvider?.config || {})
        }
      }))

      if (result && !result.success) {
        showToast(`智能体列表加载失败: ${result.error || ''}`, 'error')
      } else if (forceUpdate) {
        showToast('智能体列表已更新', 'success')
      }
    } finally {
      setLoadingCatalog(false)
      setUpdatingCatalog(false)
    }
  }, [])

  useEffect(() => {
    void loadSettingsAndCatalog(false)
  }, [loadSettingsAndCatalog])

  const selectedValues = useMemo(
    () => getProviderValues(providerDrafts, selectedProvider, currentSettings),
    [currentSettings, providerDrafts, selectedProvider]
  )

  const setProviderValue = useCallback(
    (fieldKey: string, value: string) => {
      if (!selectedProvider) return
      setProviderDrafts((prev) => ({
        ...prev,
        [selectedProvider.id]: {
          ...getProviderValues(prev, selectedProvider, currentSettings),
          [fieldKey]: value
        }
      }))
    },
    [currentSettings, selectedProvider]
  )

  const persistProvider = useCallback(
    async (provider: ProviderCatalogItem, values: Record<string, string>) => {
      const missing = getMissingRequiredFields(provider, values)
      if (missing.length > 0) {
        showToast(`缺少必填项: ${missing.join('、')}`, 'error')
        return false
      }

      if (provider.id === 'doubao') {
        await window.electron?.invoke('settings:set', {
          chatProvider: {
            manifestUrl: '',
            installed: null,
            config: values
          }
        })
        const settings = (await window.electron?.invoke('settings:getAll')) as AppSettings
        await window.electron?.invoke('engine:updateConfig', settings)
        setCurrentSettings(settings)
        setActiveId('doubao')
        return true
      }

      const installResult = await window.electron?.invoke(
        'provider:installFromUrl',
        provider.manifestUrl
      )
      if (!installResult?.success) {
        showToast(installResult?.error || '智能体安装失败', 'error')
        return false
      }

      await window.electron?.invoke('settings:set', {
        chatProvider: {
          manifestUrl: provider.manifestUrl,
          installed: installResult.installed,
          config: values
        }
      })
      const settings = (await window.electron?.invoke('settings:getAll')) as AppSettings
      await window.electron?.invoke('engine:updateConfig', settings)
      setCurrentSettings(settings)
      setActiveId(provider.id)
      return true
    },
    []
  )

  const handleSaveConfig = useCallback(async () => {
    if (!selectedProvider) return
    const ok = await persistProvider(selectedProvider, selectedValues)
    if (ok) showToast('智能体配置已保存', 'success')
  }, [persistProvider, selectedProvider, selectedValues])

  const handleActivate = useCallback(async () => {
    if (!selectedProvider) return
    const ok = await persistProvider(selectedProvider, selectedValues)
    if (ok) showToast('已切换当前智能体', 'success')
  }, [persistProvider, selectedProvider, selectedValues])

  return (
    <div className="settings-page slide-up">
      <div className="settings-page-header">
        <div>
          <div className="settings-title-row">
            <h1>智能体</h1>
            <button
              className="icon-action refresh-action"
              onClick={() => loadSettingsAndCatalog(true)}
              disabled={updatingCatalog}
              title={updatingCatalog ? '更新中...' : '更新列表'}
              aria-label={updatingCatalog ? '更新中' : '更新智能体列表'}
            >
              <span className={updatingCatalog ? 'refresh-icon spinning' : 'refresh-icon'}>
                <RefreshIcon />
              </span>
            </button>
            {updatingCatalog ? <span className="inline-status">更新中...</span> : null}
          </div>
          <p>选择负责聊天分析和内容生成的智能体，并维护各自配置。</p>
        </div>
      </div>

      {loadingCatalog ? (
        <div className="provider-hub-meta">
          <span className="spinner" />
          正在加载远端智能体列表
        </div>
      ) : null}

      <div className="provider-layout">
        <div className="provider-list">
          {!loadingCatalog && catalog.length === 0 ? (
            <div className="provider-empty">暂无可用智能体，请点击更新列表。</div>
          ) : null}
          {catalog.map((provider) => {
            const description = provider.description || provider.name
            const active = activeId === provider.id

            return (
              <button
                key={provider.id}
                className={`provider-card ${selectedId === provider.id ? 'selected' : ''}`}
                onClick={() => setSelectedId(provider.id)}
              >
                <div className="provider-card-top">
                  <span className="provider-name">{provider.name}</span>
                  {active ? (
                    <span className="provider-status" title="当前启用" aria-label="当前启用">
                      <span className="provider-status-dot" />
                      启用中
                    </span>
                  ) : null}
                </div>
                <div className="provider-desc" title={description}>
                  {description}
                </div>
                <div className="provider-version">v{provider.version}</div>
              </button>
            )
          })}
        </div>

        <div className="card provider-config-card">
          {selectedProvider ? (
            <>
              <div className="provider-config-header">
                <div>
                  <div className="card-title">智能体配置</div>
                  <h2>{selectedProvider.name}</h2>
                </div>
                <span className="provider-version">v{selectedProvider.version}</span>
              </div>

              {selectedProvider.configSchema.fields.map((field) => (
                <ProviderFieldInput
                  key={field.key}
                  field={field}
                  value={selectedValues[field.key] || ''}
                  onChange={(value) => setProviderValue(field.key, value)}
                />
              ))}

              <div className="provider-actions">
                <button className="btn btn-secondary" onClick={handleSaveConfig}>
                  保存配置
                </button>
                <button className="btn btn-primary" onClick={handleActivate}>
                  启用此智能体
                </button>
              </div>
            </>
          ) : (
            <div className="provider-empty">没有选中的智能体。</div>
          )}
        </div>
      </div>
    </div>
  )
}

function ProviderFieldInput({
  field,
  value,
  onChange
}: {
  field: ProviderConfigField
  value: string
  onChange: (value: string) => void
}): React.JSX.Element {
  return (
    <div className="form-group">
      <label className="form-label">
        {field.label}
        {field.required ? <span className="required-mark"> *</span> : null}
      </label>
      {field.type === 'textarea' ? (
        <textarea
          className="form-input"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder={field.placeholder}
          rows={4}
          readOnly={field.readonly}
        />
      ) : field.type === 'select' ? (
        <select
          className="form-input"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          disabled={field.readonly}
        >
          {(field.options || []).map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      ) : (
        <input
          className="form-input"
          type={field.type === 'password' ? 'password' : field.type === 'url' ? 'url' : 'text'}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder={field.placeholder}
          autoComplete="off"
          readOnly={field.readonly}
        />
      )}
      {field.hint ? <div className="form-hint">{field.hint}</div> : null}
    </div>
  )
}

function mergeProviderCatalog(remoteProviders: ProviderCatalogItem[]): ProviderCatalogItem[] {
  const remoteOnly = remoteProviders.filter(
    (provider) => !BUILTIN_PROVIDER_CATALOG.some((builtin) => builtin.id === provider.id)
  )
  return [...BUILTIN_PROVIDER_CATALOG, ...remoteOnly]
}

function getProviderDefaults(provider: ProviderCatalogItem | undefined): Record<string, string> {
  if (!provider) return {}
  return provider.configSchema.fields.reduce<Record<string, string>>((acc, field) => {
    acc[field.key] = field.defaultValue || ''
    return acc
  }, {})
}

function getProviderValues(
  drafts: Record<string, Record<string, string>>,
  provider: ProviderCatalogItem | undefined,
  settings: AppSettings | null
): Record<string, string> {
  if (!provider) return {}
  const defaults = getProviderDefaults(provider)
  if (provider.id === 'doubao') {
    return {
      ...defaults,
      ...(settings?.chatProvider.installed ? {} : settings?.chatProvider.config || {}),
      apiKey:
        drafts.doubao?.apiKey ||
        settings?.chatProvider.config?.apiKey ||
        settings?.vision.apiKey ||
        '',
      ...(drafts.doubao || {})
    }
  }
  return {
    ...defaults,
    ...(settings?.chatProvider.installed?.id === provider.id ? settings.chatProvider.config : {}),
    ...(drafts[provider.id] || {})
  }
}

function getMissingRequiredFields(
  provider: ProviderCatalogItem,
  values: Record<string, string>
): string[] {
  return provider.configSchema.fields
    .filter((field) => field.required && !values[field.key]?.trim())
    .map((field) => field.label)
}

let _showToast: ((msg: string, type: 'success' | 'error') => void) | null = null

export function showToast(msg: string, type: 'success' | 'error') {
  _showToast?.(msg, type)
}

function Toast() {
  const [visible, setVisible] = useState(false)
  const [message, setMessage] = useState('')
  const [type, setType] = useState<'success' | 'error'>('success')
  const timerRef = useRef<number | undefined>(undefined)

  _showToast = useCallback((msg: string, t: 'success' | 'error') => {
    setMessage(msg)
    setType(t)
    setVisible(true)
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = window.setTimeout(() => setVisible(false), 2500)
  }, [])

  return <div className={`toast ${type} ${visible ? 'show' : ''}`}>{message}</div>
}

export default App
