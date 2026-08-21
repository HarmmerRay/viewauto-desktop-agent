import { intToRGBA, Jimp } from 'jimp'
import { desktopCapturer, screen } from 'electron'
import { getWindowInfo, getWechatWindowInfo } from './window-utils'
import { AppType, ScreenRect } from './types'

const IS_MAC = process.platform === 'darwin'

interface ScreenshotCache {
  screenshotBase64: string
  nativeImage: Electron.NativeImage
  bounds: { x: number; y: number; width: number; height: number }
  display: {
    id: number
    bounds: { x: number; y: number; width: number; height: number }
    scaleFactor: number
  }
  timestamp: number
}

export type WechatCaptureMode = 'auto' | 'window' | 'screen'

export type CaptureWechatWindowOptions = {
  mode?: WechatCaptureMode
  bypassCache?: boolean
  includeRelatedWindows?: boolean
}

const screenshotCache = new Map<string, ScreenshotCache>()
const screenshotPendingPromises = new Map<string, Promise<ScreenshotCache | null>>()
const SCREENSHOT_CACHE_DURATION = 100 // 100ms

function getCropHash(crop?: { x: number; y: number; width: number; height: number }): string {
  if (!crop) return 'no-crop'
  return `${crop.x}-${crop.y}-${crop.width}-${crop.height}`
}

function getScreenshotCacheKey(
  displayId: number,
  mode: WechatCaptureMode,
  crop?: { x: number; y: number; width: number; height: number }
): string {
  return `${displayId}-${mode}-${getCropHash(crop)}`
}

export function getChatContactAvatarBounds(): {
  x: number
  y: number
  width: number
  height: number
} {
  if (IS_MAC) {
    return { x: 72, y: 64, width: 46, height: 68 }
  }
  return { x: 70, y: 64, width: 46, height: 68 }
}

export const takeWeChatScreenshot = async ({ wechatType = 'wechat' }: { wechatType: AppType }) => {
  try {
    const windowInfo = await getWindowInfo(wechatType, true)
    if (!windowInfo) return { success: false, error: '未找到应用窗口' }
    return {
      success: true,
      screenshot: windowInfo.screenshot,
      bounds: windowInfo.bounds,
      scaleFactor: windowInfo.scaleFactor
    }
  } catch (error: any) {
    return { success: false, error: error.message }
  }
}

export async function calculateRedDotPercentage(
  base64Image: string,
  onlyFirstQuadrant: boolean = false
): Promise<number | null> {
  try {
    const image = await Jimp.read(
      Buffer.from(base64Image.replace(/^data:image\/\w+;base64,/, ''), 'base64')
    )
    const { width, height } = image.bitmap
    const totalPixels = width * height
    if (totalPixels === 0) return null

    const centerX = width / 2
    const centerY = height / 2
    let redPixelCount = 0

    for (let x = 0; x < width; x++) {
      for (let y = 0; y < height; y++) {
        if (onlyFirstQuadrant && (x <= centerX || y >= centerY)) continue
        const rgba = intToRGBA(image.getPixelColor(x, y))
        const { r, g, b, a } = rgba
        if (a > 128 && r > 150 && r > g * 1.5 && r > b * 1.5) redPixelCount++
      }
    }
    return (redPixelCount / totalPixels) * 100
  } catch (error) {
    return null
  }
}

function matchesAppWindowSource(sourceName: string, appType: AppType, expectedTitle = ''): boolean {
  const normalized = sourceName.trim().toLowerCase()
  const title = expectedTitle.trim().toLowerCase()
  if (title && normalized === title) return true

  if (appType === 'wechat') {
    return normalized === '微信' || normalized === 'wechat' || normalized === 'weixin'
  }
  if (appType === 'wework') {
    return normalized === '企业微信' || normalized === 'wecom' || normalized === 'wxwork'
  }
  return normalized === 'whatsapp'
}

function isProbablyBlankImage(image: Electron.NativeImage): boolean {
  if (image.isEmpty()) return true
  const resized = image.resize({ width: 24, height: 24, quality: 'good' })
  const bitmap = resized.toBitmap()
  if (bitmap.length === 0) return true

  let minLuma = 255
  let maxLuma = 0
  let nonWhite = 0
  const pixelCount = Math.floor(bitmap.length / 4)
  for (let i = 0; i < bitmap.length; i += 4) {
    // Electron NativeImage bitmap data uses BGRA byte order on Windows.
    const b = bitmap[i]
    const g = bitmap[i + 1]
    const r = bitmap[i + 2]
    const a = bitmap[i + 3]
    if (a < 16) continue
    const luma = Math.round(r * 0.299 + g * 0.587 + b * 0.114)
    minLuma = Math.min(minLuma, luma)
    maxLuma = Math.max(maxLuma, luma)
    if (r < 247 || g < 247 || b < 247) nonWhite++
  }

  return maxLuma - minLuma < 6 && nonWhite / Math.max(1, pixelCount) < 0.02
}

async function captureAppWindowSource(
  appType: AppType,
  windowCoreResult: any,
  crop?: { x: number; y: number; width: number; height: number }
): Promise<Electron.NativeImage | null> {
  const { bounds, display } = windowCoreResult
  const scaleFactor = display.scaleFactor || 1
  const requestedSize = {
    width: Math.max(1, Math.round(bounds.width * scaleFactor)),
    height: Math.max(1, Math.round(bounds.height * scaleFactor))
  }
  const expectedTitle =
    typeof windowCoreResult.wechatWindow?.getTitle === 'function'
      ? String(windowCoreResult.wechatWindow.getTitle())
      : ''

  const windowSources = (await desktopCapturer.getSources({
    types: ['window'],
    thumbnailSize: requestedSize,
    fetchWindowIcons: false
  })) as Electron.DesktopCapturerSource[]
  const nativeWindowId = windowCoreResult.wechatWindow?.id
  const expectedSourceId =
    nativeWindowId === undefined || nativeWindowId === null ? '' : `window:${nativeWindowId}:0`
  const matchedSource =
    windowSources.find((source) => expectedSourceId && source.id === expectedSourceId) ||
    windowSources.find((source) => matchesAppWindowSource(source.name, appType, expectedTitle))
  if (!matchedSource || matchedSource.thumbnail.isEmpty()) return null

  let image = matchedSource.thumbnail
  if (crop) {
    const sourceSize = image.getSize()
    const scaleX = sourceSize.width / Math.max(1, bounds.width)
    const scaleY = sourceSize.height / Math.max(1, bounds.height)
    const cropRect = {
      x: Math.max(0, Math.round(crop.x * scaleX)),
      y: Math.max(0, Math.round(crop.y * scaleY)),
      width: Math.max(1, Math.round(crop.width * scaleX)),
      height: Math.max(1, Math.round(crop.height * scaleY))
    }
    cropRect.width = Math.min(cropRect.width, Math.max(1, sourceSize.width - cropRect.x))
    cropRect.height = Math.min(cropRect.height, Math.max(1, sourceSize.height - cropRect.y))
    image = image.crop(cropRect)
  }

  return isProbablyBlankImage(image) ? null : image
}

async function captureDisplayRegion(
  display: { id: number; bounds: Electron.Rectangle; scaleFactor: number },
  bounds: Electron.Rectangle,
  crop?: { x: number; y: number; width: number; height: number }
): Promise<Electron.NativeImage | null> {
  const scaleFactor = display.scaleFactor || 1
  const physicalWidth = Math.round(display.bounds.width * scaleFactor)
  const physicalHeight = Math.round(display.bounds.height * scaleFactor)
  const timeoutPromise = new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error('desktopCapturer timeout')), 5000)
  })
  const screenSources = (await Promise.race([
    desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: physicalWidth, height: physicalHeight }
    }),
    timeoutPromise
  ])) as Electron.DesktopCapturerSource[]
  const matchedScreenSource =
    screenSources.find((source) => String(source.display_id) === String(display.id)) ||
    screenSources[0]
  if (!matchedScreenSource || matchedScreenSource.thumbnail.isEmpty()) return null

  const sourceSize = matchedScreenSource.thumbnail.getSize()
  const sourceScaleX = sourceSize.width / Math.max(1, display.bounds.width)
  const sourceScaleY = sourceSize.height / Math.max(1, display.bounds.height)
  const relative = crop
    ? {
        x: bounds.x - display.bounds.x + crop.x,
        y: bounds.y - display.bounds.y + crop.y,
        width: crop.width,
        height: crop.height
      }
    : {
        x: bounds.x - display.bounds.x,
        y: bounds.y - display.bounds.y,
        width: bounds.width,
        height: bounds.height
      }
  const cropRect = {
    x: Math.max(0, Math.round(relative.x * sourceScaleX)),
    y: Math.max(0, Math.round(relative.y * sourceScaleY)),
    width: Math.max(1, Math.round(relative.width * sourceScaleX)),
    height: Math.max(1, Math.round(relative.height * sourceScaleY))
  }
  cropRect.width = Math.min(cropRect.width, Math.max(1, sourceSize.width - cropRect.x))
  cropRect.height = Math.min(cropRect.height, Math.max(1, sourceSize.height - cropRect.y))
  const image = matchedScreenSource.thumbnail.crop(cropRect)
  return image.isEmpty() ? null : image
}

function isUsableCaptureBounds(bounds: any): bounds is Electron.Rectangle {
  return Boolean(
    bounds &&
    Number.isFinite(bounds.x) &&
    Number.isFinite(bounds.y) &&
    Number.isFinite(bounds.width) &&
    Number.isFinite(bounds.height) &&
    bounds.width >= 20 &&
    bounds.height >= 20 &&
    bounds.x > -30000 &&
    bounds.y > -30000
  )
}

function unionBounds(left: Electron.Rectangle, right: Electron.Rectangle): Electron.Rectangle {
  const x = Math.min(left.x, right.x)
  const y = Math.min(left.y, right.y)
  const maxX = Math.max(left.x + left.width, right.x + right.width)
  const maxY = Math.max(left.y + left.height, right.y + right.height)
  return { x, y, width: maxX - x, height: maxY - y }
}

/** 两个矩形是否相交（含边缘相邻）。用于判断独立弹窗是否叠加在主窗口上方。 */
function rectOverlaps(a: Electron.Rectangle, b: Electron.Rectangle): boolean {
  return (
    a.x < b.x + b.width &&
    a.x + a.width > b.x &&
    a.y < b.y + b.height &&
    a.y + a.height > b.y
  )
}

function clampBoundsToDisplay(
  bounds: Electron.Rectangle,
  displayBounds: Electron.Rectangle
): Electron.Rectangle {
  const x = Math.max(bounds.x, displayBounds.x)
  const y = Math.max(bounds.y, displayBounds.y)
  const maxX = Math.min(bounds.x + bounds.width, displayBounds.x + displayBounds.width)
  const maxY = Math.min(bounds.y + bounds.height, displayBounds.y + displayBounds.height)
  return {
    x,
    y,
    width: Math.max(1, maxX - x),
    height: Math.max(1, maxY - y)
  }
}

function exeBasename(pathValue: unknown): string {
  const raw = String(pathValue || '')
  const base = raw.split(/[\\/]/).pop() || ''
  return base.toLowerCase().replace(/\.exe$/, '')
}

function exeDirectory(pathValue: unknown): string {
  const raw = String(pathValue || '')
  const idx = Math.max(raw.lastIndexOf('\\'), raw.lastIndexOf('/'))
  return (idx >= 0 ? raw.slice(0, idx) : '').toLowerCase()
}

function getOwnerWindowId(candidate: any): number {
  try {
    return Number(candidate?.getOwner?.()?.id) || 0
  } catch {
    return 0
  }
}

/**
 * 判断某个顶层窗口是否属于微信。
 *
 * 微信的“添加朋友”等弹窗是独立 HWND，且在新版微信里可能运行在独立进程甚至独立
 * 辅助 exe（如 WeChatAppEx.exe）里。只按 processId 匹配会漏掉这类弹窗，因此这里
 * 额外用“可执行文件名 / 安装目录 / 窗口归属关系”兜底。
 */
function isWechatRelatedWindow(
  candidate: any,
  processId: number,
  mainWindowId: number,
  mainExe: string,
  mainDir: string
): boolean {
  // 就是主窗口本身。
  if (mainWindowId > 0 && Number(candidate?.id) === mainWindowId) return true
  // 同一进程（原逻辑）。
  if (processId > 0 && Number(candidate?.processId) === processId) return true
  // 同一可执行文件（多进程但同 exe）。
  if (mainExe && exeBasename(candidate?.path) === mainExe) return true
  // 同一安装目录（新版微信的辅助 exe 与主程序同目录）。
  if (mainDir && exeDirectory(candidate?.path) === mainDir) return true
  // 被主窗口拥有（模态弹窗，GWLP_HWNDPARENT 指向主窗口）。
  if (mainWindowId > 0 && getOwnerWindowId(candidate) === mainWindowId) return true

  // 兜底：可执行文件路径或窗口标题里出现 wechat / weixin / 微信（大小写不敏感）。
  // 新版微信的“添加朋友”“朋友验证”等弹窗可能跑在 WeChatAppEx.exe 等辅助进程里，
  // 目录、exe 名、进程、owner 都可能与主程序不同，前几条规则会全部落空。
  const rawPath = String(candidate?.path || '').toLowerCase()
  const rawTitle = String(candidate?.getTitle?.() || '').toLowerCase()
  if (rawPath.includes('wechat') || rawPath.includes('weixin') || rawTitle.includes('微信')) {
    return true
  }
  return false
}

/** 判断可执行文件名是否属于微信（weixin / wechat / wechatappex 等辅助 exe）。 */
function looksLikeWechatExe(pathValue: unknown): boolean {
  const exe = exeBasename(pathValue)
  return exe.includes('wechat') || exe.includes('weixin')
}

/**
 * 通过窗口列表查找微信的独立弹窗（如“添加朋友”“朋友验证”）。
 *
 * 这些弹窗在新版微信里是独立 HWND，可能运行在辅助进程（WeChatAppEx.exe），并且不一定
 * 叠加在主窗口上方——此时主窗口合成截图（getWechatCompositeBounds 只并入 owned 或相交
 * 的窗口）会漏掉它。这里直接按窗口标题关键词 + 微信可执行文件匹配，返回弹窗的屏幕
 * bounds（逻辑像素），供后续“只截这个弹窗区域、再定位其中的按钮”使用。
 *
 * titleKeywords 为空时，返回第一个可见的微信相关非主窗口（按面积降序），用于兜底识别
 * “当前弹出的那个微信弹窗”。
 */
export function findWechatPopupWindow(
  titleKeywords: string[] = []
): { title: string; bounds: Electron.Rectangle } | null {
  if (process.platform !== 'win32') return null
  try {
    const { windowManager } = require('node-window-manager')
    const keywords = titleKeywords.map((k) => String(k).toLowerCase()).filter(Boolean)
    // 主窗口标题（精确匹配后排除），避免把主窗口当成弹窗。
    const mainTitles = ['微信', '企业微信', 'wechat', 'weixin', 'wecom', 'wxwork']

    let bestByArea: { title: string; bounds: Electron.Rectangle } | null = null

    for (const win of windowManager.getWindows() || []) {
      if (!win?.isVisible?.()) continue
      const rawTitle = String(win.getTitle?.() || '').replace(/^\u200e/, '').trim()
      const bounds = win.getBounds?.()
      if (!bounds || !isUsableCaptureBounds(bounds)) continue
      // 只认微信相关窗口（可执行文件为 weixin/wechat/wechatappex 等），避免误选其它程序。
      if (!looksLikeWechatExe(win.path)) continue

      const normalized = rawTitle.toLowerCase()

      // 1) 标题关键词命中（例如“添加朋友”“朋友验证”）→ 直接返回。
      if (keywords.length > 0 && keywords.some((k) => normalized.includes(k))) {
        return {
          title: rawTitle,
          bounds: { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height }
        }
      }

      // 2) 兜底：非主窗口的微信弹窗（标题不是“微信”等），记下面积最大的那个。
      // 资料卡弹窗的标题可能是昵称而非固定文案，需要靠“非主窗口”这个信号识别。
      if (rawTitle && !mainTitles.includes(normalized)) {
        const area = bounds.width * bounds.height
        if (!bestByArea || area > bestByArea.bounds.width * bestByArea.bounds.height) {
          bestByArea = {
            title: rawTitle,
            bounds: { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height }
          }
        }
      }
    }

    return bestByArea
  } catch (error) {
    console.warn('[findWechatPopupWindow] 枚举微信弹窗失败:', error)
    return null
  }
}

function getWechatCompositeBounds(windowCoreResult: any): Electron.Rectangle {
  const mainBounds = windowCoreResult.bounds as Electron.Rectangle
  if (process.platform !== 'win32') return mainBounds

  try {
    const mainWindow = windowCoreResult.wechatWindow
    const processId = Number(mainWindow?.processId)
    const mainWindowId = Number(mainWindow?.id)
    const mainExe = exeBasename(mainWindow?.path)
    const mainDir = exeDirectory(mainWindow?.path)

    const { windowManager } = require('node-window-manager')
    const candidates = (windowManager.getWindows() || [])
      .filter((candidate: any) => candidate?.isVisible?.())
      .filter((candidate: any) =>
        isWechatRelatedWindow(candidate, processId, mainWindowId, mainExe, mainDir)
      )
      .map((candidate: any) => ({
        title: String(candidate.getTitle?.() || ''),
        bounds: candidate.getBounds?.(),
        owned: mainWindowId > 0 && getOwnerWindowId(candidate) === mainWindowId
      }))
      .filter((candidate: any) => isUsableCaptureBounds(candidate.bounds))

    let composite = { ...mainBounds }
    const included = new Set<number>()

    // 微信的“添加朋友”“朋友验证”等弹窗虽是独立 HWND，但都是模态弹窗：要么被主窗口拥有
    // （GWLP_HWNDPARENT 指向主窗口），要么叠加在主窗口上方。如果把所有微信相关窗口
    // （含远离主窗口的小程序/视频号等 WeChatAppEx.exe 独立窗口）一并并入合成区域，会导致
    // 截图面积过大、目标按钮被稀释，VLM 识别不准且浪费 token。这里只并入“被主窗口拥有”
    // 或“与主窗口相交”的弹窗。
    candidates.forEach((candidate: any, index: number) => {
      if (candidate.owned || rectOverlaps(mainBounds, candidate.bounds)) {
        included.add(index)
        composite = unionBounds(composite, candidate.bounds)
      }
    })

    const display = screen.getDisplayMatching(mainBounds)
    const clamped = clampBoundsToDisplay(composite, display.bounds)
    if (clamped.width !== mainBounds.width || clamped.height !== mainBounds.height) {
      console.log('[captureWechatWindow] included related WeChat windows:', {
        processId,
        mainWindowId,
        mainExe,
        mainBounds,
        compositeBounds: clamped,
        windows: candidates
          .filter((_candidate: any, index: number) => included.has(index))
          .map((candidate: any) => ({
            title: candidate.title,
            bounds: candidate.bounds,
            owned: candidate.owned
          }))
      })
    }
    return clamped
  } catch (error) {
    console.warn('[captureWechatWindow] failed to inspect related WeChat windows:', error)
    return mainBounds
  }
}

export async function captureWechatWindow(
  appType: AppType = 'wechat',
  crop?: { x: number; y: number; width: number; height: number },
  options: CaptureWechatWindowOptions = {}
): Promise<any> {
  try {
    // bypassCache 时同步绕过窗口信息缓存，确保每次截图都基于窗口的实时位置与尺寸，
    // 而不是 5 秒前的旧 bounds（窗口移动/还原后坐标会漂移）。
    const bypassCache = options.bypassCache ?? false
    const windowCoreResult = await getWechatWindowInfo(appType, { bypassCache })
    if (!windowCoreResult) return { success: false, error: '未找到窗口' }

    const { display, bounds } = windowCoreResult
    const mode = options.mode ?? 'auto'
    const screenCaptureBounds =
      mode === 'screen' && options.includeRelatedWindows && !crop
        ? getWechatCompositeBounds(windowCoreResult)
        : bounds
    const screenDisplay = screen.getDisplayMatching(screenCaptureBounds)
    const cacheKey = getScreenshotCacheKey(screenDisplay.id, mode, crop)

    if (!bypassCache) {
      const cached = screenshotCache.get(cacheKey)
      const now = Date.now()
      if (cached && now - cached.timestamp < SCREENSHOT_CACHE_DURATION) {
        return {
          success: true,
          screenshotBase64: cached.screenshotBase64,
          nativeImage: cached.nativeImage,
          bounds: cached.bounds,
          display: cached.display,
          timestamp: cached.timestamp,
          captureMethod: 'cache'
        }
      }

      const pending = screenshotPendingPromises.get(cacheKey)
      if (pending) {
        const result = await pending
        if (result) {
          return {
            success: true,
            screenshotBase64: result.screenshotBase64,
            nativeImage: result.nativeImage,
            bounds: result.bounds,
            display: result.display,
            timestamp: result.timestamp,
            captureMethod: 'pending'
          }
        }
      }
    }

    let captureMethod: WechatCaptureMode = mode === 'auto' ? 'window' : mode
    const capturePromise = (async (): Promise<ScreenshotCache | null> => {
      try {
        let image: Electron.NativeImage | null = null

        if (mode === 'screen') {
          // Screen capture reads the final desktop composition, including WeChat's transient
          // dropdowns and popup layers that are omitted by a window-only capture source.
          image = await captureDisplayRegion(screenDisplay, screenCaptureBounds, crop)
        } else if (mode === 'window') {
          image = await captureAppWindowSource(appType, windowCoreResult, crop)
        } else {
          // Default behavior remains window-first so background monitoring is not covered by
          // SightFlow or other windows. Interactive flows can explicitly request screen mode.
          image = await captureAppWindowSource(appType, windowCoreResult, crop)
          if (!image) {
            captureMethod = 'screen'
            image = await captureDisplayRegion(screenDisplay, screenCaptureBounds, crop)
          }
        }
        if (!image) return null

        const baseBounds = captureMethod === 'screen' ? screenCaptureBounds : bounds
        const resultBounds = crop
          ? {
              x: baseBounds.x + crop.x,
              y: baseBounds.y + crop.y,
              width: crop.width,
              height: crop.height
            }
          : baseBounds
        const cacheResult: ScreenshotCache = {
          screenshotBase64: image.toDataURL(),
          nativeImage: image,
          bounds: resultBounds,
          display: captureMethod === 'screen' ? screenDisplay : display,
          timestamp: Date.now()
        }
        if (!bypassCache) screenshotCache.set(cacheKey, cacheResult)
        return cacheResult
      } catch (error) {
        console.error('[captureWechatWindow] Screenshot capture error:', error)
        return null
      } finally {
        if (!bypassCache) screenshotPendingPromises.delete(cacheKey)
      }
    })()

    if (!bypassCache) screenshotPendingPromises.set(cacheKey, capturePromise)
    const captureResult = await capturePromise
    if (!captureResult) return { success: false, error: '截图失败', display, captureMethod }

    console.log('[captureWechatWindow] captured:', {
      appType,
      method: captureMethod,
      bypassCache,
      bounds: captureResult.bounds,
      imageSize: captureResult.nativeImage.getSize()
    })
    return {
      success: true,
      screenshotBase64: captureResult.screenshotBase64,
      nativeImage: captureResult.nativeImage,
      bounds: captureResult.bounds,
      display: captureResult.display,
      timestamp: captureResult.timestamp,
      captureMethod
    }
  } catch (err: any) {
    return { success: false, error: err?.message || String(err) }
  }
}

/**
 * 按绝对屏幕坐标矩形截图（box-select 路线用）。
 *
 * `rect` 是逻辑像素的绝对屏幕坐标（来自用户框选向导）。函数会查到该坐标所在
 * 显示器，按 scaleFactor 转成物理像素裁剪，返回 base64 dataURL + NativeImage。
 *
 * 没有像 captureWechatWindow 那样的缓存：BoxSelectDevice 自己控制采集节奏，
 * 一次轮询里 hasUnreadMessage / hasChatAreaChanged 都是各自截图各自比较，
 * 多余缓存反而引入"diff 不刷新"的微妙 bug。
 */
export async function captureScreenRegion(rect: ScreenRect): Promise<{
  success: boolean
  screenshotBase64?: string
  nativeImage?: Electron.NativeImage
  error?: string
  display?: { id: number; bounds: Electron.Rectangle; scaleFactor: number }
}> {
  try {
    const display = screen.getDisplayMatching({
      x: rect.x,
      y: rect.y,
      width: Math.max(1, rect.width),
      height: Math.max(1, rect.height)
    })

    const scaleFactor = display.scaleFactor || 1
    const physicalWidth = Math.round(display.bounds.width * scaleFactor)
    const physicalHeight = Math.round(display.bounds.height * scaleFactor)

    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => reject(new Error('desktopCapturer timeout')), 5000)
    })
    const screenSources = (await Promise.race([
      desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: { width: physicalWidth, height: physicalHeight }
      }),
      timeoutPromise
    ])) as Electron.DesktopCapturerSource[]

    const matchedSource =
      screenSources.find((s) => String(s.display_id) === String(display.id)) || screenSources[0]
    if (!matchedSource) return { success: false, error: '未找到匹配的屏幕源' }

    const cropRect = {
      x: Math.round((rect.x - display.bounds.x) * scaleFactor),
      y: Math.round((rect.y - display.bounds.y) * scaleFactor),
      width: Math.max(1, Math.round(rect.width * scaleFactor)),
      height: Math.max(1, Math.round(rect.height * scaleFactor))
    }

    const cropped = matchedSource.thumbnail.crop(cropRect)
    return {
      success: true,
      screenshotBase64: cropped.toDataURL(),
      nativeImage: cropped,
      display: { id: display.id, bounds: display.bounds, scaleFactor }
    }
  } catch (err: any) {
    return { success: false, error: err?.message || String(err) }
  }
}

/**
 * 截图 chatMainArea 区域，返回 NativeImage
 *
 * 从 LayoutCache 获取 chatMainArea.bbox → 计算 crop 区域 → 局部截图
 * 用于 diff 检测：对比前后两张 chatMainArea 截图判断是否有新消息
 */
export async function captureChatMainArea(appType: AppType): Promise<Electron.NativeImage | null> {
  try {
    // 延迟导入避免循环引用
    const { getLayoutCache, bboxToCropBounds } = await import('./vision-utils')

    const layout = getLayoutCache(appType)
    if (!layout?.chatMainArea) {
      console.log('[captureChatMainArea] 未找到 chatMainArea 缓存')
      return null
    }

    if (layout.chatMainArea.rect) {
      const screenshotResult = await captureScreenRegion(layout.chatMainArea.rect)
      if (!screenshotResult.success || !screenshotResult.nativeImage) {
        console.log('[captureChatMainArea] 绝对区域截图失败:', screenshotResult.error)
        return null
      }
      return screenshotResult.nativeImage
    }

    if (!layout.chatMainArea.bbox) {
      console.log('[captureChatMainArea] chatMainArea 缺少 bbox/rect')
      return null
    }

    const windowInfo = await getWindowInfo(appType, false)
    if (!windowInfo?.bounds) {
      console.log('[captureChatMainArea] 获取窗口信息失败')
      return null
    }

    // 从归一化 bbox (0-1000) 计算出 crop 区域（逻辑像素）
    const cropBounds = bboxToCropBounds(layout.chatMainArea.bbox, windowInfo.bounds)
    const crop = {
      x: cropBounds.x,
      y: cropBounds.y,
      width: cropBounds.width,
      height: cropBounds.height
    }

    const screenshotResult = await captureWechatWindow(appType, crop)
    if (!screenshotResult.success) {
      console.log('[captureChatMainArea] 截图失败:', screenshotResult.error)
      return null
    }

    if (screenshotResult.nativeImage) {
      return screenshotResult.nativeImage
    }

    console.log('[captureChatMainArea] 截图结果无 nativeImage:', {
      appType,
      crop,
      keys: Object.keys(screenshotResult),
      hasScreenshotBase64: Boolean(screenshotResult.screenshotBase64)
    })
    return null
  } catch (error: any) {
    console.error('[captureChatMainArea] 异常:', error)
    return null
  }
}
