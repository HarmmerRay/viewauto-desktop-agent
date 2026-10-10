// src/main/license.ts
// RAuto 激活码授权模块 — 启动联网校验，无离线宽限。
//
// 服务端部署于 us-vps，nginx 反代路径 /57dad064af8185c3/rauto/：
//   POST /api/activate  首次激活（绑定设备指纹）
//   POST /api/verify    启动校验（设备不匹配 = 已被其他设备使用）
//   POST /api/rebind    换绑到本机（旧设备立即失效）
//
// 设备指纹 = sha256(盐 + 操作系统机器 UUID)，不落明文 UUID。

import { createHash, randomUUID } from 'crypto'
import { execSync } from 'child_process'
import { readFileSync } from 'fs'
import os from 'os'
import Store from 'electron-store'

const StoreClass =
  typeof Store === 'function' ? Store : (Store as unknown as { default: typeof Store }).default

export const LICENSE_API_BASE = (
  process.env.SIGHTFLOW_LICENSE_API_URL || 'http://199.102.216.216/57dad064af8185c3/rauto'
).replace(/\/+$/, '')

const FETCH_TIMEOUT_MS = 10_000

// ── 授权本地存储（userData/license.json）──
// deviceIdFallback：仅在无法读取机器 UUID 时使用的兜底随机 ID，持久化保持稳定。
const licenseStore = new StoreClass({
  name: 'license',
  defaults: {
    code: '',
    deviceIdFallback: ''
  }
}) as unknown as Store<Record<string, string>>

export type LicenseVerifyResult =
  | { ok: true; expiresAt: number | null }
  | { ok: false; error: string; message: string }

function rawMachineId(): string {
  try {
    if (process.platform === 'darwin') {
      const out = execSync('ioreg -rd1 -c IOPlatformExpertDevice', { timeout: 5000 }).toString()
      const m = out.match(/"IOPlatformUUID"\s*=\s*"([^"]+)"/)
      if (m) return m[1]
    } else if (process.platform === 'win32') {
      const out = execSync('reg query HKLM\\SOFTWARE\\Microsoft\\Cryptography /v MachineGuid', {
        timeout: 5000
      }).toString()
      const m = out.match(/MachineGuid\s+REG_SZ\s+(\S+)/)
      if (m) return m[1]
    } else {
      return readFileSync('/etc/machine-id', 'utf-8').trim()
    }
  } catch (error) {
    console.error('[license] 读取机器 UUID 失败，使用兜底随机 ID', error)
  }
  let fallback = licenseStore.get('deviceIdFallback')
  if (!fallback) {
    fallback = randomUUID()
    licenseStore.set('deviceIdFallback', fallback)
  }
  return fallback
}

export function getDeviceId(): string {
  return createHash('sha256').update(`rauto-license-v1:${rawMachineId()}`).digest('hex')
}

export function getDeviceName(): string {
  return os.hostname()
}

export function getSavedLicense(): { code: string } {
  return { code: licenseStore.get('code') || '' }
}

function saveLicense(code: string): void {
  licenseStore.set({ code })
}

async function post(path: string, body: Record<string, unknown>): Promise<LicenseVerifyResult> {
  let response: Response
  try {
    response = await fetch(`${LICENSE_API_BASE}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
    })
  } catch {
    return { ok: false, error: 'NETWORK', message: '网络连接失败，无法验证授权，请检查网络后重试' }
  }
  let payload: Record<string, unknown> = {}
  try {
    payload = (await response.json()) as Record<string, unknown>
  } catch {
    return { ok: false, error: 'BAD_RESPONSE', message: '授权服务异常，请稍后再试' }
  }
  if (payload.ok === true) {
    return {
      ok: true,
      expiresAt: typeof payload.expires_at === 'number' ? payload.expires_at : null
    }
  }
  return {
    ok: false,
    error: String(payload.error || 'UNKNOWN'),
    message: String(payload.message || '授权校验失败')
  }
}

/** 启动校验：用本地保存的激活码+本机指纹联网验证。 */
export async function verifyStoredLicense(): Promise<LicenseVerifyResult> {
  const { code } = getSavedLicense()
  if (!code) {
    return { ok: false, error: 'NOT_ACTIVATED', message: '尚未激活' }
  }
  return post('/api/verify', { code, device_id: getDeviceId() })
}

/** 首次激活。成功后写入本地存储。 */
export async function activateLicense(code: string): Promise<LicenseVerifyResult> {
  const result = await post('/api/activate', {
    code,
    device_id: getDeviceId(),
    device_name: getDeviceName()
  })
  if (result.ok) saveLicense(code.trim().toUpperCase())
  return result
}

/** 换绑到本机。成功后写入本地存储（旧设备授权立即失效）。 */
export async function rebindLicense(code: string): Promise<LicenseVerifyResult> {
  const result = await post('/api/rebind', {
    code,
    device_id: getDeviceId(),
    device_name: getDeviceName()
  })
  if (result.ok) saveLicense(code.trim().toUpperCase())
  return result
}
