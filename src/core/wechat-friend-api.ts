// src/core/wechat-friend-api.ts
// 客户记录接口客户端 — 用于自动添加微信好友的取号与状态回写。
//
// 后端接口（内网可访问）：
//   GET  /api/pending      查询待添加客户（直接返回一个待添加记录）
//   POST /api/update_status 更新状态 { id, status, added_by_wechat? }

import { WechatFriendCustomer } from './wechat-friend-types'

export const DEFAULT_API_BASE_URL =
  process.env.SIGHTFLOW_CUSTOMER_API_URL || 'http://192.168.8.94:8500'

function normalizeBaseUrl(baseUrl?: string): string {
  const raw = String(baseUrl || '').trim()
  if (!raw) return DEFAULT_API_BASE_URL
  return raw.replace(/\/+$/, '')
}

function toCustomer(value: unknown): WechatFriendCustomer | null {
  if (!value || typeof value !== 'object') return null
  const item = value as Record<string, any>
  const id = Number(item.id)
  if (!Number.isFinite(id)) return null
  const wechat = String(item.wechat || '').trim()
  if (!wechat) return null

  return {
    id,
    name: String(item.name || '').trim(),
    wechat,
    channel: String(item.channel || '').trim(),
    status: String(item.status || ''),
    remark: typeof item.remark === 'string' ? item.remark : undefined,
    note: typeof item.note === 'string' ? item.note : undefined,
    created_at: typeof item.created_at === 'string' ? item.created_at : undefined,
    added_at: typeof item.added_at === 'string' ? item.added_at : undefined,
    verified_at: typeof item.verified_at === 'string' ? item.verified_at : undefined,
    added_by_wechat:
      item.added_by_wechat === null || item.added_by_wechat === undefined
        ? undefined
        : String(item.added_by_wechat)
  }
}

/**
 * 取一个“待添加”客户。
 * 返回 null 表示当前没有待添加的客户。
 */
export async function fetchNextPendingCustomer(
  baseUrl?: string
): Promise<WechatFriendCustomer | null> {
  const url = `${normalizeBaseUrl(baseUrl)}/api/pending`
  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(`查询待添加客户失败：HTTP ${response.status}`)
  }
  const payload = await response.json()
  // /api/pending 返回 { ok: true, customer: {...} } 或 { ok: false, reason: "无待添加客户" }。
  const body = (payload && typeof payload === 'object' ? payload : {}) as Record<string, any>
  if (body.ok === false) return null
  return toCustomer(body.customer)
}

/**
 * 回写客户状态。addedByWechat 存在时会一并写入 added_by_wechat。
 */
export async function updateCustomerStatus(
  id: number,
  status: string,
  addedByWechat?: string | null,
  baseUrl?: string
): Promise<void> {
  const body: Record<string, any> = { id, status }
  if (addedByWechat) body.added_by_wechat = addedByWechat

  const response = await fetch(`${normalizeBaseUrl(baseUrl)}/api/update_status`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  })
  if (!response.ok) {
    throw new Error(`更新客户状态失败：HTTP ${response.status}`)
  }
}
