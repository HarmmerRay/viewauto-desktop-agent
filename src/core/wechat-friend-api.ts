// src/core/wechat-friend-api.ts
// 客户记录接口客户端 — 用于自动添加微信好友的取号与状态回写。
//
// 后端接口（内网可访问）：
//   GET  /api/list        查询客户记录（status=待添加&limit=1 取最新一个）
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
    created_at: typeof item.created_at === 'string' ? item.created_at : undefined,
    added_at: typeof item.added_at === 'string' ? item.added_at : undefined,
    verified_at: typeof item.verified_at === 'string' ? item.verified_at : undefined,
    added_by_wechat:
      item.added_by_wechat === null || item.added_by_wechat === undefined
        ? undefined
        : String(item.added_by_wechat)
  }
}

function extractList(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload
  if (payload && typeof payload === 'object') {
    const obj = payload as Record<string, any>
    if (Array.isArray(obj.list)) return obj.list
    if (Array.isArray(obj.data)) return obj.data
    if (Array.isArray(obj.customers)) return obj.customers
    if (Array.isArray(obj.results)) return obj.results
  }
  return []
}

/**
 * 取一个“待添加”客户（最新更新的一个）。
 * 返回 null 表示当前没有待添加的客户。
 */
export async function fetchNextPendingCustomer(
  baseUrl?: string
): Promise<WechatFriendCustomer | null> {
  const url = `${normalizeBaseUrl(baseUrl)}/api/list?status=${encodeURIComponent('待添加')}&limit=1`
  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(`查询待添加客户失败：HTTP ${response.status}`)
  }
  const payload = await response.json()
  const list = extractList(payload)
  for (const item of list) {
    const customer = toCustomer(item)
    if (customer) return customer
  }
  return null
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
