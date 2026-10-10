// src/renderer/src/LicenseWindow.tsx
// RAuto 激活码授权窗口。
//
// 状态机：
//   未激活（无本地授权）        → 激活码表单
//   NETWORK（断网）            → 错误横幅 + [重试]
//   DEVICE_CONFLICT（码已被别的设备用）→ 横幅"激活码已被使用" + [换绑到本机] + [换个激活码]
//   其他错误（禁用/过期/不存在）→ 横幅 + 表单（预填）
import { useEffect, useState } from 'react'

interface LicenseResult {
  ok: boolean
  error?: string
  message?: string
}

interface LicenseState {
  code?: string
  reason?: string
  reasonMessage?: string
}

type Mode = 'form' | 'conflict' | 'retry'

export default function LicenseWindow(): React.JSX.Element {
  const [code, setCode] = useState('')
  const [mode, setMode] = useState<Mode>('form')
  const [banner, setBanner] = useState('')
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    window.electron?.invoke('license:getState').then((raw: unknown) => {
      const state = (raw || {}) as LicenseState
      if (state?.code) setCode(state.code)
      if (!state?.reason) return
      setBanner(state.reasonMessage || '')
      if (state.reason === 'DEVICE_CONFLICT') setMode('conflict')
      else if (state.reason === 'NETWORK') setMode('retry')
      else setMode('form') // NOT_ACTIVATED / DISABLED / EXPIRED / CODE_NOT_FOUND
    })
  }, [])

  async function handleActivate(): Promise<void> {
    if (!code.trim()) {
      setBanner('请填写激活码')
      return
    }
    setLoading(true)
    setBanner('')
    const r = (await window.electron?.invoke('license:activate', {
      code: code.trim()
    })) as LicenseResult
    setLoading(false)
    if (!r?.ok) {
      setBanner(r?.message || '激活失败')
      if (r?.error === 'DEVICE_CONFLICT') setMode('conflict')
    }
    // 成功时主进程会关闭本窗口并打开主界面，无需处理
  }

  async function handleRebind(): Promise<void> {
    if (!window.confirm('确认换绑到本机？\n换绑后，原来设备上的授权将立即失效。')) return
    setLoading(true)
    setBanner('')
    const r = (await window.electron?.invoke('license:rebind', {
      code: code.trim()
    })) as LicenseResult
    setLoading(false)
    if (!r?.ok) setBanner(r?.message || '换绑失败')
  }

  async function handleRetry(): Promise<void> {
    setLoading(true)
    setBanner('')
    const r = (await window.electron?.invoke('license:retry')) as LicenseResult
    setLoading(false)
    if (!r?.ok) {
      setBanner(r?.message || '仍然无法连接，请检查网络')
      if (r?.error === 'DEVICE_CONFLICT') setMode('conflict')
      else setMode('retry')
    }
  }

  function handleQuit(): void {
    window.electron?.invoke('license:quit')
  }

  return (
    <div className="license-page">
      <div className="license-card">
        <h1 className="license-title">RAuto</h1>
        <p className="license-subtitle">激活码授权验证</p>

        {banner && <div className="license-banner">{banner}</div>}

        {mode === 'retry' && (
          <div className="license-actions">
            <button className="license-btn primary" disabled={loading} onClick={handleRetry}>
              {loading ? '正在验证…' : '重 试'}
            </button>
            <button className="license-btn ghost" onClick={handleQuit}>
              退 出
            </button>
          </div>
        )}

        {mode === 'conflict' && (
          <div className="license-actions">
            <button className="license-btn primary" disabled={loading} onClick={handleRebind}>
              {loading ? '正在换绑…' : '换绑到本机'}
            </button>
            <button
              className="license-btn ghost"
              onClick={() => {
                setMode('form')
                setBanner('')
              }}
            >
              换个激活码
            </button>
            <button className="license-btn ghost" onClick={handleQuit}>
              退 出
            </button>
          </div>
        )}

        {mode === 'form' && (
          <>
            <label className="license-label">激活码</label>
            <input
              className="license-input code"
              value={code}
              onChange={(e) => setCode(e.target.value.toUpperCase())}
              placeholder="XXXX-XXXX-XXXX-XXXX"
              maxLength={19}
            />
            <div className="license-actions">
              <button className="license-btn primary" disabled={loading} onClick={handleActivate}>
                {loading ? '正在激活…' : '激 活'}
              </button>
              <button className="license-btn ghost" onClick={handleQuit}>
                退 出
              </button>
            </div>
          </>
        )}

        <p className="license-hint">一个激活码只能在一台设备上使用，换绑后原设备将失效</p>
      </div>
    </div>
  )
}
