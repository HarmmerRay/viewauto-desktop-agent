// src/renderer/src/components/SettingsPanel.tsx
// 基础配置面板 — 视觉接口密钥 / 视觉模型 / 视觉服务地址 / 客户记录后端地址 / 持续添加好友间隔
//
// 通过 IPC（settings:* / engine:*）读写主进程中的设置。

import { useCallback, useEffect, useState } from 'react'
import { t } from '../i18n'
import { showToast, type AppSettings } from '../App'

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

export default function SettingsPanel(): React.JSX.Element {
  const [visionApiKey, setVisionApiKey] = useState('')
  const [visionModel, setVisionModel] = useState('doubao-seed-2-0-lite-260215')
  const [visionBaseUrl, setVisionBaseUrl] = useState('https://ark.cn-beijing.volces.com/api/v3')
  const [showVisionKey, setShowVisionKey] = useState(false)
  const [customerApiUrl, setCustomerApiUrl] = useState('')
  const [friendAddIntervalMinutes, setFriendAddIntervalMinutes] = useState(0)
  const [testing, setTesting] = useState(false)

  useEffect(() => {
    const load = async (): Promise<void> => {
      const settings = (await window.electron?.invoke('settings:getAll')) as AppSettings | undefined
      if (settings) {
        setVisionApiKey(settings.vision?.apiKey || '')
        setVisionModel(settings.vision?.model || 'doubao-seed-2-0-lite-260215')
        setVisionBaseUrl(settings.vision?.baseURL || 'https://ark.cn-beijing.volces.com/api/v3')
        setCustomerApiUrl(settings.customerApiUrl || '')
        setFriendAddIntervalMinutes(settings.friendAddIntervalMinutes ?? 0)
      }
    }

    void load()
  }, [])

  const handleSaveVision = useCallback(async () => {
    const payload: Partial<AppSettings> = {
      vision: { apiKey: visionApiKey, model: visionModel, baseURL: visionBaseUrl },
      customerApiUrl,
      friendAddIntervalMinutes
    }
    await window.electron?.invoke('settings:set', payload)
    await window.electron?.invoke('engine:updateConfig', {
      ...((await window.electron?.invoke('settings:getAll')) as AppSettings),
      ...payload,
      vision: { apiKey: visionApiKey, model: visionModel, baseURL: visionBaseUrl }
    })
    showToast(t('settings.saved'), 'success')
  }, [visionApiKey, visionModel, visionBaseUrl, customerApiUrl, friendAddIntervalMinutes])

  const handleTestConnection = useCallback(async () => {
    if (!visionApiKey) return
    setTesting(true)
    try {
      const result = await window.electron?.invoke('engine:testConnection', {
        apiKey: visionApiKey,
        model: visionModel,
        baseURL: visionBaseUrl
      })
      if (result?.success) {
        showToast(t('settings.testConnection.success'), 'success')
      } else {
        showToast(`${t('settings.testConnection.fail')}: ${result?.error || ''}`, 'error')
      }
    } catch (e) {
      showToast(`${t('settings.testConnection.fail')}: ${(e as Error).message}`, 'error')
    } finally {
      setTesting(false)
    }
  }, [visionApiKey, visionModel, visionBaseUrl])

  return (
    <div className="settings-page slide-up">
      <div className="settings-page-header">
        <div>
          <h1>{t('settings.baseConfig')}</h1>
          <p>{t('settings.baseConfig.subtitle')}</p>
        </div>
      </div>

      <div className="card base-settings-card">
        <div className="card-title">{t('settings.vision')}</div>

        <div className="form-group">
          <label className="form-label">{t('settings.visionApiKey')}</label>
          <div className="input-with-action">
            <input
              className="form-input"
              type={showVisionKey ? 'text' : 'password'}
              value={visionApiKey}
              onChange={(e) => setVisionApiKey(e.target.value)}
              placeholder={t('settings.visionApiKey.placeholder')}
              autoComplete="off"
            />
            <button
              type="button"
              className="input-action-btn"
              onClick={() => setShowVisionKey((v) => !v)}
              title={showVisionKey ? t('settings.hideKey') : t('settings.showKey')}
              aria-label={showVisionKey ? t('settings.hideKey') : t('settings.showKey')}
            >
              {showVisionKey ? <EyeOffIcon /> : <EyeIcon />}
            </button>
          </div>
          <div className="form-hint">{t('settings.visionApiKey.hint')}</div>
        </div>

        <div className="form-group">
          <label className="form-label">{t('settings.visionModel')}</label>
          <input
            className="form-input"
            value={visionModel}
            onChange={(e) => setVisionModel(e.target.value)}
            autoComplete="off"
          />
        </div>

        <div className="form-group">
          <label className="form-label">{t('settings.visionBaseUrl')}</label>
          <input
            className="form-input"
            value={visionBaseUrl}
            onChange={(e) => setVisionBaseUrl(e.target.value)}
            autoComplete="off"
          />
        </div>

        <div className="form-group">
          <label className="form-label">{t('settings.customerApiUrl')}</label>
          <input
            className="form-input"
            type="url"
            value={customerApiUrl}
            onChange={(e) => setCustomerApiUrl(e.target.value)}
            placeholder={t('settings.customerApiUrl.placeholder')}
            autoComplete="off"
          />
          <div className="form-hint">{t('settings.customerApiUrl.hint')}</div>
        </div>

        <div className="form-group">
          <label className="form-label">{t('settings.friendAddInterval')}</label>
          <select
            className="form-input"
            value={friendAddIntervalMinutes}
            onChange={(e) => setFriendAddIntervalMinutes(Number(e.target.value))}
          >
            <option value={0}>{t('settings.friendAddInterval.option0')}</option>
            <option value={5}>{t('settings.friendAddInterval.option5')}</option>
            <option value={10}>{t('settings.friendAddInterval.option10')}</option>
            <option value={15}>{t('settings.friendAddInterval.option15')}</option>
            <option value={30}>{t('settings.friendAddInterval.option30')}</option>
            <option value={60}>{t('settings.friendAddInterval.option60')}</option>
          </select>
          <div className="form-hint">{t('settings.friendAddInterval.hint')}</div>
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
