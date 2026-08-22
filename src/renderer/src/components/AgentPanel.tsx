// src/renderer/src/components/AgentPanel.tsx
// 智能体面板 — 管理本地智能体（名称 + OpenAI 兼容 apiKey/prompt 配置）。
//
// 通过 IPC（agent:*）在主进程 settings 中增删改查本地智能体。

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { showToast, type LocalAgent } from '../App'

const EyeIcon = (): React.JSX.Element => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.8"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z" />
    <circle cx="12" cy="12" r="3" />
  </svg>
)

const EyeOffIcon = (): React.JSX.Element => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.8"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-10-7-10-7a18.45 18.45 0 0 1 5.06-5.94" />
    <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 10 7 10 7a18.5 18.5 0 0 1-2.16 3.19" />
    <path d="M14.12 14.12a3 3 0 1 1-4.24-4.24" />
    <path d="M1 1l22 22" />
  </svg>
)

interface AgentField {
  key: keyof LocalAgent['config']
  label: string
  type: 'password' | 'text' | 'url' | 'textarea'
  required?: boolean
  placeholder?: string
  hint?: string
}

const AGENT_FIELDS: AgentField[] = [
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
    hint: '回复流程会把聊天截图发送给模型，因此模型必须支持图片输入。'
  },
  {
    key: 'baseURL',
    label: 'Base URL',
    type: 'url',
    required: true,
    placeholder: 'https://ark.cn-beijing.volces.com/api/v3',
    hint: '支持填写 API 根地址，或直接填写完整的 /chat/completions 地址。'
  },
  {
    key: 'systemPrompt',
    label: '系统提示词',
    type: 'textarea',
    placeholder: '你是一个微信自动回复助手。根据截图中的聊天内容，生成合适的回复...'
  }
]

interface AgentListResult {
  agents: LocalAgent[]
  activeAgentId: string
}

interface AgentMutationResult {
  success: boolean
  agents?: LocalAgent[]
  activeAgentId?: string
  agent?: LocalAgent
  error?: string
}

export default function AgentPanel(): React.JSX.Element {
  const [agents, setAgents] = useState<LocalAgent[]>([])
  const [activeAgentId, setActiveAgentId] = useState('')
  const [selectedId, setSelectedId] = useState('')
  const [nameDraft, setNameDraft] = useState('')
  const [configDraft, setConfigDraft] = useState<LocalAgent['config']>({
    apiKey: '',
    model: '',
    baseURL: '',
    systemPrompt: ''
  })
  const [loading, setLoading] = useState(true)
  const [showApiKey, setShowApiKey] = useState(false)
  const prevSelectedIdRef = useRef('')

  const selected = useMemo(
    () => agents.find((agent) => agent.id === selectedId) || agents[0],
    [agents, selectedId]
  )

  const loadAgents = useCallback(async () => {
    setLoading(true)
    try {
      const result = (await window.electron?.invoke('agent:list')) as AgentListResult | undefined
      const list = result?.agents || []
      const active = result?.activeAgentId || list[0]?.id || ''
      setAgents(list)
      setActiveAgentId(active)
      setSelectedId((current) =>
        current && list.some((agent) => agent.id === current) ? current : active
      )
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadAgents()
  }, [loadAgents])

  // 选中项变化时重置编辑草稿（保存后 id 不变，不会打断正在编辑的内容）。
  useEffect(() => {
    if (!selected || prevSelectedIdRef.current === selected.id) return
    prevSelectedIdRef.current = selected.id
    setNameDraft(selected.name)
    setConfigDraft({ ...selected.config })
  }, [selected])

  const setField = useCallback((key: keyof LocalAgent['config'], value: string) => {
    setConfigDraft((prev) => ({ ...prev, [key]: value }))
  }, [])

  const missingRequired = useMemo(
    () =>
      AGENT_FIELDS.filter((field) => field.required && !configDraft[field.key]?.trim()).map(
        (field) => field.label
      ),
    [configDraft]
  )

  const handleAdd = useCallback(async () => {
    const result = (await window.electron?.invoke('agent:add')) as AgentMutationResult | undefined
    if (!result?.success) {
      showToast(result?.error || '新增智能体失败', 'error')
      return
    }
    setAgents(result.agents || [])
    setActiveAgentId(result.activeAgentId || '')
    setSelectedId(result.agent?.id || '')
    showToast('已新增智能体', 'success')
  }, [])

  const persist = useCallback(
    async (id: string): Promise<boolean> => {
      if (missingRequired.length > 0) {
        showToast(`缺少必填项: ${missingRequired.join('、')}`, 'error')
        return false
      }
      const result = (await window.electron?.invoke('agent:save', id, {
        name: nameDraft,
        config: configDraft
      })) as AgentMutationResult | undefined
      if (!result?.success) {
        showToast(result?.error || '保存失败', 'error')
        return false
      }
      setAgents(result.agents || [])
      return true
    },
    [configDraft, missingRequired, nameDraft]
  )

  const handleSave = useCallback(async () => {
    if (!selected) return
    if (await persist(selected.id)) showToast('智能体配置已保存', 'success')
  }, [persist, selected])

  const handleActivate = useCallback(async () => {
    if (!selected) return
    if (!(await persist(selected.id))) return
    const result = (await window.electron?.invoke('agent:activate', selected.id)) as
      | AgentMutationResult
      | undefined
    if (!result?.success) {
      showToast(result?.error || '启用失败', 'error')
      return
    }
    setActiveAgentId(result.activeAgentId || selected.id)
    showToast('已切换当前智能体', 'success')
  }, [persist, selected])

  const handleDelete = useCallback(async () => {
    if (!selected) return
    if (agents.length <= 1) {
      showToast('至少保留一个智能体', 'error')
      return
    }
    if (!window.confirm(`确定删除智能体「${selected.name}」吗？`)) return
    const result = (await window.electron?.invoke('agent:delete', selected.id)) as
      | AgentMutationResult
      | undefined
    if (!result?.success) {
      showToast(result?.error || '删除失败', 'error')
      return
    }
    const list = result.agents || []
    const nextActive = result.activeAgentId || list[0]?.id || ''
    setAgents(list)
    setActiveAgentId(nextActive)
    setSelectedId(nextActive)
    showToast('已删除智能体', 'success')
  }, [agents.length, selected])

  return (
    <div className="settings-page slide-up">
      <div className="settings-page-header">
        <div>
          <h1>智能体</h1>
          <p>本地智能体 = 名称 + apiKey + 提示词，可新增、重命名、删除并切换启用。</p>
        </div>
      </div>

      {loading ? (
        <div className="provider-hub-meta">
          <span className="spinner" />
          正在加载智能体
        </div>
      ) : null}

      <div className="provider-layout">
        <div className="provider-list">
          {!loading && agents.length === 0 ? (
            <div className="provider-empty">暂无智能体，点击下方按钮新增。</div>
          ) : null}
          {agents.map((agent) => {
            const active = activeAgentId === agent.id
            return (
              <button
                key={agent.id}
                className={`provider-card ${selected?.id === agent.id ? 'selected' : ''}`}
                onClick={() => setSelectedId(agent.id)}
              >
                <div className="provider-card-top">
                  <span className="provider-name">{agent.name}</span>
                  {active ? (
                    <span className="provider-status" title="当前启用">
                      <span className="provider-status-dot" />
                      启用中
                    </span>
                  ) : null}
                </div>
                <div className="provider-desc" title={agent.config.model}>
                  {agent.config.model || '未填写模型'}
                </div>
                <div className="provider-version">{agent.config.baseURL || '未填写 Base URL'}</div>
              </button>
            )
          })}
          <button className="btn btn-secondary" onClick={handleAdd}>
            + 新增智能体
          </button>
        </div>

        <div className="card provider-config-card">
          {selected ? (
            <>
              <div className="provider-config-header">
                <div>
                  <div className="card-title">智能体配置</div>
                  <h2>{selected.name}</h2>
                </div>
              </div>

              <div className="form-group">
                <label className="form-label">名称</label>
                <input
                  className="form-input"
                  value={nameDraft}
                  onChange={(event) => setNameDraft(event.target.value)}
                  placeholder="给这个智能体起个名字"
                  autoComplete="off"
                />
              </div>

              {AGENT_FIELDS.map((field) => (
                <div className="form-group" key={field.key}>
                  <label className="form-label">
                    {field.label}
                    {field.required ? <span className="required-mark"> *</span> : null}
                  </label>
                  {field.type === 'textarea' ? (
                    <textarea
                      className="form-input"
                      value={configDraft[field.key]}
                      onChange={(event) => setField(field.key, event.target.value)}
                      placeholder={field.placeholder}
                      rows={4}
                    />
                  ) : field.type === 'password' ? (
                    <div className="input-with-action">
                      <input
                        className="form-input"
                        type={showApiKey ? 'text' : 'password'}
                        value={configDraft[field.key]}
                        onChange={(event) => setField(field.key, event.target.value)}
                        placeholder={field.placeholder}
                        autoComplete="off"
                      />
                      <button
                        type="button"
                        className="input-action-btn"
                        onClick={() => setShowApiKey((value) => !value)}
                        title={showApiKey ? '隐藏' : '显示'}
                        aria-label={showApiKey ? '隐藏' : '显示'}
                      >
                        {showApiKey ? <EyeOffIcon /> : <EyeIcon />}
                      </button>
                    </div>
                  ) : (
                    <input
                      className="form-input"
                      type={field.type === 'url' ? 'url' : 'text'}
                      value={configDraft[field.key]}
                      onChange={(event) => setField(field.key, event.target.value)}
                      placeholder={field.placeholder}
                      autoComplete="off"
                    />
                  )}
                  {field.hint ? <div className="form-hint">{field.hint}</div> : null}
                </div>
              ))}

              <div className="provider-actions">
                <button className="btn btn-danger" onClick={handleDelete}>
                  删除
                </button>
                <button className="btn btn-secondary" onClick={handleSave}>
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
