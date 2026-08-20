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

/** 返回可执行文件小写 basename（不含 .exe 后缀），用于按进程路径识别窗口归属。 */
function exeBasename(pathValue: unknown): string {
  const raw = String(pathValue || '')
  const base = raw.split(/[\\/]/).pop() || ''
  return base.toLowerCase().replace(/\.exe$/, '')
}

async function getWechatWindowInWin(appType: AppType): Promise<PlatformWindow | null> {
  try {
    const { windowManager } = require('node-window-manager')

    // 微信新版是 Weixin.exe，旧版是 WeChat.exe；企业微信是 WXWork.exe / WeCom.exe。
    // 最小化 / 隐藏到托盘时主窗口标题可能退化为空串，因此这里优先按可执行文件名识别
    // 微信相关窗口，标题匹配只作兜底，避免主窗口被漏掉。
    const exeNames =
      appType === 'wechat' ? ['weixin', 'wechat'] : ['wxwork', 'wecom', 'wework']

    const allWindows = windowManager.getWindows() || []
    const related = allWindows.filter((window: any) => {
      const exe = exeBasename(window.path)
      if (exeNames.includes(exe)) return true
      return matchWechatType(window.getTitle(), appType)
    })

    if (related.length === 0) return null

    const byAreaDesc = (a: any, b: any): number => {
      const ab = getWindowBounds(a)
      const bb = getWindowBounds(b)
      const areaA = (ab?.width ?? 0) * (ab?.height ?? 0)
      const areaB = (bb?.width ?? 0) * (bb?.height ?? 0)
      return areaB - areaA
    }

    // 主窗口识别（关键）：主窗口的专属特征是标题精确等于中文主标题“微信”/“企业微信”，
    // 且它“拥有”其它窗口（其它窗口的 ownerId 指向它）。即使最小化，主窗口标题也保留，
    // 只是 bounds 退化为任务栏按钮大小（约 160x28）。
    //
    // 不能简单地按“面积最大”选主窗口：最小化后主窗口面积退化（160x28），而微信还有一批
    // 标题为“Weixin”或“WxTrayIconMessageWindow”的隐藏辅助窗口（160x112 或 2580x1029），
    // 面积更大，若混在一起按面积排序会误选到它们，restore 出来就变成很小的空白窗口。
    const normalizeTitle = (window: any): string =>
      String(window.getTitle?.() ?? '').replace(/^\u200e/, '').trim()
    const exactMainTitles = appType === 'wechat' ? ['微信'] : ['企业微信']

    // 其它窗口的 ownerId 指向主窗口，因此主窗口 id 会出现在 ownerId 集合里。
    const ownerIds = new Set(
      related.map((window: any) => getWindowOwnerId(window)).filter((id: number) => id > 0)
    )
    const isOwning = (window: any): boolean => ownerIds.has(Number(window.id))

    // 优先：标题精确等于中文主标题的窗口（无论是否最小化，主窗口都保留该标题）。
    const exactMain = related.filter((window: any) =>
      exactMainTitles.includes(normalizeTitle(window))
    )

    let mainWindow: PlatformWindow | null = null
    if (exactMain.length > 0) {
      // 有精确主标题窗口：优先选“拥有其它窗口”的那个（通常唯一）。
      const owning = exactMain.filter(isOwning)
      mainWindow = (owning.length > 0 ? owning : exactMain)[0] || null
    } else {
      // 无精确中文主标题（英文版 / 隐藏到托盘导致标题退化）时，依次退回：
      // “拥有其它窗口且标题匹配”→“标题匹配”→“拥有其它窗口”→“全部”，每层按面积取最大兜底。
      const titled = related.filter((window: any) => matchWechatType(window.getTitle(), appType))
      const titledOwning = titled.filter(isOwning)
      const allOwning = related.filter(isOwning)
      const pool =
        titledOwning.length > 0
          ? titledOwning
          : titled.length > 0
            ? titled
            : allOwning.length > 0
              ? allOwning
              : related
      mainWindow = [...pool].sort(byAreaDesc)[0] || null
    }

    if (!mainWindow) return null

    // 最小化 / 隐藏检测：最小化时 bounds 落到 (-32000,-32000) 且尺寸退化为任务栏按钮大小
    // （validateWindowBounds 会因尺寸过小判定无效）；隐藏到托盘时 isVisible 为 false。
    // 两种状态都要还原，否则后续截图取到屏幕外或空白区域。
    const bounds = getWindowBounds(mainWindow)
    const minimized = isMinimizedWindowBounds(bounds)
    const hidden = !mainWindow.isVisible?.()

    if (minimized || hidden) {
      try {
        mainWindow.restore?.()
        mainWindow.show?.()
        mainWindow.bringToTop?.()
      } catch (err: any) {
        console.error('[window-utils] 还原微信窗口失败:', err.message)
      }

      // 轮询等待 bounds 回到屏幕内且尺寸有效，最多约 2 秒。之前固定等 350ms 常常不够，
      // 窗口还没还原完就被拿去截图，导致取到 (-32000) 屏幕外或空白的错误区域。
      for (let i = 0; i < 10; i++) {
        await new Promise((resolve) => setTimeout(resolve, 200))
        const b = getWindowBounds(mainWindow)
        if (b && !isMinimizedWindowBounds(b) && validateWindowBounds(b)) break
      }
    }

    return mainWindow
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
    // 命中缓存时也要做一次轻量检测：消息监控等持续运行场景下，用户可能在两次截图之间
    // 把微信最小化或隐藏到托盘。此时若直接返回缓存的旧 bounds（仍是正常坐标），后续截图
    // 会取到空白区域。检测到窗口已最小化/隐藏就跳过缓存，走下面的重新枚举 + 自动还原逻辑。
    const cachedWindow = cached.result?.wechatWindow
    if (cachedWindow) {
      const cachedBounds = getWindowBounds(cachedWindow)
      const cachedHidden =
        typeof cachedWindow.isVisible === 'function' && !cachedWindow.isVisible()
      if (!isMinimizedWindowBounds(cachedBounds) && !cachedHidden) {
        return cached.result
      }
    }
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
