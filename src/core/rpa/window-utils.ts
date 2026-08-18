import { screen } from 'electron'
import activeWin from 'active-win'
import { AppType } from './types'
import { captureWechatWindow } from './screenshot-utils'

const IS_WINDOWS = process.platform === 'win32'
const IS_MAC = process.platform === 'darwin'

// 包装带超时的 activeWin 调用
async function getOpenWindowsSafe(): Promise<any[]> {
  try {
    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => reject(new Error('active-win getOpenWindows timeout')), 5000)
    })
    
    // 如果系统没有给权限，activeWin在某些版本可能卡死，强制5秒超时
    const windows = await Promise.race([
      activeWin.getOpenWindows(),
      timeoutPromise
    ])
    return windows as any[]
  } catch (err: any) {
    console.error('[window-utils] getOpenWindowsSafe error or timeout:', err.message)
    return []
  }
}

export function matchWechatType(name: string, appType: AppType) {
  const normalizedName = String(name || '').replace(/^\u200e/, '').trim().toLowerCase()
  if ((appType as string) === 'whatsapp') {
    return ['whatsapp', 'whatsapp.app', 'whatsapp.exe'].includes(normalizedName)
  }
  const wechatName =
    appType === 'wechat'
      ? ['微信', '微信.app', 'wechat', 'weixin']
      : ['企业微信', '企业微信.app', 'wecom', 'wxwork']
  return wechatName.includes(normalizedName)
}

function getWechatWindow(appType: AppType, windows: any[]): any {
  let appTargetName: string[]
  let windowTitle: string[]

  if ((appType as string) === 'whatsapp') {
    appTargetName = ['‎WhatsApp', '‎WhatsApp.app', '‎WhatsApp.exe', 'WhatsApp']
    windowTitle = ['‎WhatsApp', '‎WhatsApp.app', '‎WhatsApp.exe', 'WhatsApp']
  } else {
    appTargetName =
      appType === 'wechat' ? ['微信', '微信.app', 'WeChat'] : ['企业微信', '企业微信.app']
    windowTitle = appType === 'wechat' ? ['微信', 'Weixin'] : ['企业微信']
  }

  const allWechatWindows = windows.filter((window: any) =>
    appTargetName.includes(window?.owner?.name)
  )

  if (allWechatWindows.length > 1) {
    const selected = allWechatWindows.find((window: any) => windowTitle.includes(window.title))
    return selected
  }
  if (allWechatWindows.length === 1) {
    return allWechatWindows[0]
  }
  return undefined
}

type PlatformWindow = {
  getBounds?: () => { x?: number; y?: number; width?: number; height?: number }
  bounds?: { x?: number; y?: number; width?: number; height?: number }
  [key: string]: any
}

async function getWechatWindowInWin(appType: AppType): Promise<PlatformWindow | null> {
  try {
    const { windowManager } = require('node-window-manager')

    // 不要直接信任 getActiveWindow()：填写验证消息 / 备注时，当前激活窗口往往是
    // “添加朋友”“朋友验证”等独立弹窗（标题也可能叫“微信”）。若把弹窗当成主窗口，
    // 后续截图 bounds 会指向弹窗而非主窗口，主窗口和搜索框反而被漏掉。
    // 这里枚举所有标题匹配的窗口，优先选“不被其它窗口拥有”且尺寸最大的主窗口。
    const appWindows = (windowManager.getWindows() || []).filter((window: any) =>
      matchWechatType(window.getTitle(), appType)
    )

    // 主窗口通常不被任何窗口拥有（getOwner 为空），弹窗的 owner 会指向主窗口。
    const notOwned = appWindows.filter((window: any) => !getWindowOwnerId(window))
    const candidatePool = notOwned.length > 0 ? notOwned : appWindows

    // 主窗口通常是尺寸最大的那个，先按面积降序，避免误选到大的独立弹窗。
    const sorted = [...candidatePool].sort((a: any, b: any) => {
      const ab = getWindowBounds(a)
      const bb = getWindowBounds(b)
      const areaA = (ab?.width ?? 0) * (ab?.height ?? 0)
      const areaB = (bb?.width ?? 0) * (bb?.height ?? 0)
      return areaB - areaA
    })

    const foundWindow =
      sorted.find((window: any) => {
        const bounds = getWindowBounds(window)
        return window.isVisible() && validateWindowBounds(bounds) && !isMinimizedWindowBounds(bounds)
      }) ||
      sorted.find((window: any) => {
        const bounds = getWindowBounds(window)
        return validateWindowBounds(bounds) && !isMinimizedWindowBounds(bounds)
      }) ||
      sorted.find((window: any) => window.isVisible())

    if (!foundWindow) return null

    // Windows reports a minimized window at roughly (-32000, -32000), while closing WeChat
    // normally hides its main window in the tray. Both states produce a white/empty capture.
    const bounds = getWindowBounds(foundWindow)
    if (!foundWindow.isVisible() || isMinimizedWindowBounds(bounds)) {
      foundWindow.restore?.()
      foundWindow.show?.()
      foundWindow.bringToTop?.()
      await new Promise((resolve) => setTimeout(resolve, 350))
    }

    return foundWindow
  } catch (err: any) {
    console.error('[window-utils] getWechatWindowInWin error:', err.message)
    return null
  }
}

async function getWechatWindowInMac(appType: AppType): Promise<PlatformWindow | null> {
  const windows = await getOpenWindowsSafe()
  if (!windows || windows.length === 0) {
    return null
  }
  return getWechatWindow(appType, windows) || null
}

function getWindowBounds(window: PlatformWindow): {
  x?: number
  y?: number
  width?: number
  height?: number
} | null {
  if (typeof window.getBounds === 'function') {
    return window.getBounds()
  }
  if (window.bounds) {
    return window.bounds
  }
  return null
}

/** 返回窗口的 owner 窗口 id。主窗口通常没有 owner（返回 0），弹窗的 owner 指向主窗口。 */
function getWindowOwnerId(window: PlatformWindow): number {
  try {
    return Number((window as any)?.getOwner?.()?.id) || 0
  } catch {
    return 0
  }
}

function isMinimizedWindowBounds(
  bounds: { x?: number; y?: number; width?: number; height?: number } | null
): boolean {
  return Boolean(bounds && ((bounds.x ?? 0) <= -30000 || (bounds.y ?? 0) <= -30000))
}

function validateWindowBounds(bounds: { x?: number; y?: number; width?: number; height?: number } | null): bounds is { x: number; y: number; width: number; height: number } {
  if (!bounds) return false
  if (bounds.x === undefined || bounds.y === undefined || !bounds.width || !bounds.height ||
     (bounds.width && bounds.width < 100) || (bounds.height && bounds.height < 100)) {
    return false
  }
  const isVisible = bounds.width > 0 && bounds.height > 0
  return isVisible
}

interface WechatWindowInfoCache {
  result: any | null
  timestamp: number
}
const WINDOW_INFO_CACHE_DURATION = 5000 // 5 seconds cache
const wechatWindowInfoCache = new Map<AppType, WechatWindowInfoCache>()
const wechatWindowInfoPendingPromises = new Map<AppType, Promise<any>>()

export async function getWechatWindowInfo(
  appType: AppType,
  options: { bypassCache?: boolean } = {}
) {
  const bypassCache = options.bypassCache ?? false
  const cached = wechatWindowInfoCache.get(appType)
  const now = Date.now()
  if (!bypassCache && cached && now - cached.timestamp < WINDOW_INFO_CACHE_DURATION) {
    return cached.result
  }

  const pendingPromise = wechatWindowInfoPendingPromises.get(appType)
  if (!bypassCache && pendingPromise) return pendingPromise

  const queryPromise = (async () => {
    try {
      const wechatWindow = IS_WINDOWS ? await getWechatWindowInWin(appType) : IS_MAC ? await getWechatWindowInMac(appType) : null
      if (!wechatWindow) return null

      const bounds = getWindowBounds(wechatWindow)
      if (!validateWindowBounds(bounds)) return null

      const display = screen.getDisplayMatching({
        x: bounds.x,
        y: bounds.y,
        width: bounds.width,
        height: bounds.height
      })

      const result = {
        wechatWindow,
        bounds: { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height },
        wechatType: appType,
        display: { id: display.id, scaleFactor: display.scaleFactor, bounds: display.bounds }
      }
      wechatWindowInfoCache.set(appType, { result, timestamp: Date.now() })
      return result
    } catch (e) {
      console.error('getWechatWindowInfo error:', e)
      return null
    } finally {
      wechatWindowInfoPendingPromises.delete(appType)
    }
  })()

  wechatWindowInfoPendingPromises.set(appType, queryPromise)
  return queryPromise
}

export const getWindowInfo = async (appType: AppType = 'wechat', includeScreenshot: boolean = true) => {
  if (!includeScreenshot) {
    const result = await getWechatWindowInfo(appType)
    if (!result) return null
    return {
      wechatWindow: result.wechatWindow,
      bounds: result.bounds,
      wechatType: result.wechatType,
      scaleFactor: result.display.scaleFactor
    }
  }

  try {
    const windowCore = await getWechatWindowInfo(appType)
    if (!windowCore) return null

    const result = await captureWechatWindow(appType)
    if (!result.success || !result.screenshotBase64) return null

    return {
      wechatWindow: windowCore.wechatWindow,
      bounds: result.bounds!,
      wechatType: windowCore.wechatType,
      scaleFactor: result.display!.scaleFactor,
      screenshot: result.screenshotBase64
    }
  } catch (error) {
    console.error('getWindowInfo failure:', error)
    return null
  }
}

/**
 * 同步获取窗口信息（从内存缓存读取，不发起系统调用）
 * 前提：measureLayout 时已经调过 getWindowInfo/getWechatWindowInfo，缓存有数据
 */
export function getWindowInfoSync(appType: AppType): {
  bounds: { x: number; y: number; width: number; height: number }
  scaleFactor: number
} | null {
  const cached = wechatWindowInfoCache.get(appType)
  if (!cached?.result) return null

  return {
    bounds: cached.result.bounds,
    scaleFactor: cached.result.display?.scaleFactor || 1
  }
}
