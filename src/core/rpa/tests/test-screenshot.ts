import * as fs from 'node:fs'
import { captureWechatWindow } from '../screenshot-utils'
import { getWechatWindowInfo } from '../window-utils'

export async function runScreenshotTest() {
  console.log('[Test] Running WeChat window screenshot test...')

  try {
    const windowInfo = await getWechatWindowInfo('wechat')
    console.log('[Test] Window info:', windowInfo
      ? {
          bounds: windowInfo.bounds,
          display: windowInfo.display,
          title: windowInfo.wechatWindow?.getTitle?.()
        }
      : null)

    const result = await captureWechatWindow('wechat')
    if (!result.success || !result.screenshotBase64) {
      throw new Error(result.error || '微信窗口截图失败')
    }

    const base64Data = result.screenshotBase64.replace(/^data:image\/\w+;base64,/, '')
    fs.writeFileSync('test-screenshot.png', Buffer.from(base64Data, 'base64'))
    console.log('[Test] Screenshot saved:', {
      path: 'test-screenshot.png',
      bytes: Buffer.byteLength(base64Data, 'base64'),
      bounds: result.bounds,
      display: result.display,
      captureMethod: result.captureMethod
    })
  } catch (err: any) {
    console.error('[Test] Screenshot failed', err)
  }
}