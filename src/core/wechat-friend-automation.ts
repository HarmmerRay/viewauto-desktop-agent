import { AIClient } from './ai-client'
import { humanLikeClickAt, pressEnterAction, replaceTextAtAction } from './rpa/input-utils'
import { captureScreenRegion, captureWechatWindow, findWechatPopupWindow } from './rpa/screenshot-utils'
import { getRobot } from './rpa/util'
import { parsePoint, pointToScreenCoords } from './rpa/vision-utils'
import { getWechatWindowInfo } from './rpa/window-utils'
import { TraceStepInput } from './trace/trace-types'
import { AddWechatFriendRequest } from './wechat-friend-types'

export interface WechatFriendAutomationCallbacks {
  log(type: 'thinking' | 'reply' | 'skip' | 'error', content: string): void
  trace(step: TraceStepInput): void
}

type LocatedTarget = {
  point: [number, number]
  screenshot: string
  rawResponse: string
}

type WechatUiState = 'not_found' | 'already_friend' | 'already_sent' | 'waiting' | 'user_not_found'

type LocateTargetOptions = {
  initialDelayMs?: number
  retryIntervalMs?: number
  timeoutMs?: number
  retryNotFound?: boolean
  /** 目标位于微信独立弹窗（如“添加朋友”“朋友验证”）内时，传入标题关键词用于检测弹窗。 */
  popupTitles?: string[]
}

class WechatUiStateError extends Error {
  constructor(
    readonly state: WechatUiState,
    message: string
  ) {
    super(message)
    this.name = 'WechatUiStateError'
  }
}

class WechatTargetNotReadyError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'WechatTargetNotReadyError'
  }
}

class WechatFriendStoppedError extends Error {
  constructor() {
    super('已请求停止添加好友')
    this.name = 'WechatFriendStoppedError'
  }
}

/** 微信提示无法找到该用户（账号不存在/已注销），应跳过该账号继续后续流程。 */
class WechatFriendUserNotFoundError extends Error {
  constructor(message = '微信提示无法找到该用户，账号可能不存在或已注销') {
    super(message)
    this.name = 'WechatFriendUserNotFoundError'
  }
}

/** 微信触发风控（操作过于频繁，请稍后再试），本次申请未真正发出成功，应跳过该账号。 */
class WechatFriendRateLimitedError extends Error {
  constructor(message = '微信提示操作过于频繁，请稍后再试（触发风控）') {
    super(message)
    this.name = 'WechatFriendRateLimitedError'
  }
}

/**
 * 该帐号已经是当前登录微信的好友（此前已被人工手动添加）。
 * 携带当前登录微信号，供上层回写“已申请过”状态（added_by_wechat = 当前登录微信号）。
 */
class WechatFriendAlreadyFriendError extends Error {
  constructor(readonly wechatId: string | null) {
    super('该帐号已经是微信好友')
    this.name = 'WechatFriendAlreadyFriendError'
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** 好友添加流程中可能出现的微信弹窗标题关键词（用于窗口列表检测与聚焦截图）。 */
const FRIEND_POPUP_TITLES = ['添加朋友', '朋友验证', '发送朋友申请', '验证申请', '添加']

/**
 * 判断窗口 bounds 是否处于最小化状态。
 *
 * Windows 会把最小化窗口报告在屏幕外约 (-32000, -32000) 的位置，通过检查 x/y 是否
 * 远小于 0 即可识别最小化。这与 window-utils 中的 isMinimizedWindowBounds 逻辑一致。
 */
function isMinimizedBounds(
  bounds?: { x?: number; y?: number; width?: number; height?: number } | null
): boolean {
  if (!bounds) return false
  return (bounds.x ?? 0) <= -30000 || (bounds.y ?? 0) <= -30000
}

/**
 * 微信好友添加自动化。
 *
 * prepare 负责搜索帐号、打开资料页、填写验证信息，并停在最终“发送”按钮前；
 * confirm 会重新截图和定位按钮，再完成真正的外部提交。每次视觉定位都重新基于当前
 * 微信窗口截图计算屏幕坐标，避免窗口移动、缩放或弹窗变化造成旧坐标漂移。
 */
export class WechatFriendAutomation {
  private preparedRequest: AddWechatFriendRequest | null = null
  private stopRequested = false

  constructor(
    private readonly aiClient: AIClient,
    private readonly callbacks: WechatFriendAutomationCallbacks
  ) {}

  /**
   * 请求立即中断当前自动化流程。
   *
   * 单个正在 await 的 VLM 调用或 sleep 无法从外部强制中止，但流程会在当前这一步
   * 结束后立刻抛出 WechatFriendStoppedError 退出，不再执行后续任何步骤。
   */
  stop(): void {
    this.stopRequested = true
    this.preparedRequest = null
  }

  private assertNotStopped(): void {
    if (this.stopRequested) throw new WechatFriendStoppedError()
  }

  async prepare(rawRequest: AddWechatFriendRequest): Promise<void> {
    const request = normalizeRequest(rawRequest)
    this.preparedRequest = null
    this.stopRequested = false

    this.callbacks.log('thinking', `准备添加微信好友：${request.account}`)
    this.callbacks.trace({
      phase: 'think',
      summary: '解析添加微信好友任务',
      reasoning: {
        content: `目标帐号：${request.account}；验证消息：${request.verificationMessage ? '已填写' : '未填写'}；备注：${request.remark ? '已填写' : '未填写'}`
      },
      outcome: { status: 'ok' }
    })

    await this.focusWechatWindow()
    this.assertNotStopped()

    // 新路径：主窗口「➕」→ 下拉菜单「添加朋友」打开添加朋友弹窗，再在弹窗内直接输
    // 微信号回车。不再依赖会话列表顶部搜索框的“网络查找手机/QQ号”下拉行（该行高度
    // 会随搜索结果变化，固定坐标点不中导致流程不稳定）。
    await this.openAddFriendEntry()
    this.assertNotStopped()

    const inputStartedAt = Date.now()
    const searchTarget = await this.fillAddFriendSearchBox(request.account)
    this.assertNotStopped()
    this.callbacks.trace({
      phase: 'act',
      summary: '在添加朋友弹窗中输入待添加的微信帐号',
      screenshotBase64: searchTarget.screenshot,
      action: { kind: 'input', target: searchTarget.point, payload: request.account },
      outcome: { status: 'ok', latencyMs: Date.now() - inputStartedAt }
    })

    await this.clickAddToContactsButton()
    this.assertNotStopped()

    await sleep(400)
    if (request.verificationMessage) {
      await this.locateAndFill(
        '验证消息输入框',
        '请定位微信“朋友验证”或“发送朋友申请”表单中的验证消息输入框。它通常位于“你需要发送验证申请，等待对方通过”提示下方。只输出输入框内部可点击位置：<point>x,y</point>。',
        request.verificationMessage,
        '填写好友验证消息',
        false,
        FRIEND_POPUP_TITLES
      )
    }

    if (request.remark) {
      await this.locateAndFill(
        '备注输入框',
        '请定位当前好友申请表单中的“备注”“备注名”输入框。只输出输入框内部可点击位置：<point>x,y</point>。如果当前表单没有备注输入框，输出 [NOT_FOUND]。',
        request.remark,
        '填写好友备注',
        true,
        FRIEND_POPUP_TITLES
      )
    }

    await sleep(400)
    this.assertNotStopped()
    const finalTarget = await this.locateTarget(
      '最终发送按钮',
      '请定位当前微信好友申请表单中会真正提交申请的“发送”“确定”或“完成”按钮。只输出按钮内部可点击位置：<point>x,y</point>。不要执行点击。',
      { popupTitles: FRIEND_POPUP_TITLES }
    )
    this.callbacks.trace({
      phase: 'verify',
      summary: '好友申请已填写，等待人工确认发送',
      screenshotBase64: finalTarget.screenshot,
      action: { kind: 'wait', target: finalTarget.point, payload: '等待确认后重新定位并点击发送' },
      outcome: { status: 'ok' }
    })
    this.callbacks.log('reply', '好友申请已填写，已停在发送按钮前，请确认后再发送')
    this.preparedRequest = request
  }

  async confirm(): Promise<void> {
    const request = this.preparedRequest
    if (!request) throw new Error('没有等待确认的好友申请')

    // 不在这里 focusWechatWindow()：填完备注后“朋友验证”弹窗仍在前台，置前主窗口
    // 反而会把弹窗盖住，导致找不到发送按钮。直接基于当前界面定位发送按钮即可。
    this.assertNotStopped()
    let target: LocatedTarget
    try {
      target = await this.locateTarget(
        '最终发送按钮',
        '当前应当停留在微信好友申请表单。请定位会真正提交申请的“发送”“确定”或“完成”按钮。只输出按钮内部可点击位置：<point>x,y</point>。如果当前已经显示申请已发送，输出 [ALREADY_SENT]。',
        { popupTitles: FRIEND_POPUP_TITLES }
      )
    } catch (error) {
      if (error instanceof WechatUiStateError && error.state === 'already_sent') {
        this.callbacks.trace({
          phase: 'verify',
          summary: '微信界面显示好友申请已经发送',
          outcome: { status: 'ok' }
        })
        this.callbacks.log('skip', '微信界面显示好友申请已经发送')
        this.preparedRequest = null
        return
      }
      throw error
    }

    const start = Date.now()
    await humanLikeClickAt(target.point[0], target.point[1])
    this.assertNotStopped()
    this.callbacks.trace({
      phase: 'act',
      summary: '点击发送微信好友申请',
      screenshotBase64: target.screenshot,
      action: { kind: 'friend_request', target: target.point, payload: request.account },
      outcome: { status: 'ok', latencyMs: Date.now() - start }
    })

    await sleep(900)

    // 发送后检查是否触发微信风控（“操作过于频繁，请稍后再试”）。触发风控说明本次
    // 申请并未真正发出成功，应跳过该账号而不是回写为“已发申请”。
    if (await this.isRateLimitedAfterSend()) {
      this.callbacks.log(
        'skip',
        `客户 ${request.account} 触发微信风控（操作过于频繁），本次好友申请未成功`
      )
      this.callbacks.trace({
        phase: 'verify',
        summary: '发送后检测到微信风控提示，本次申请未成功',
        outcome: { status: 'skip', detail: '操作过于频繁，请稍后再试' }
      })
      this.preparedRequest = null
      throw new WechatFriendRateLimitedError()
    }

    const after = await captureWechatWindow('wechat', undefined, {
      mode: 'screen',
      bypassCache: true,
      includeRelatedWindows: true
    })
    this.callbacks.trace({
      phase: 'verify',
      summary: '记录发送后的微信界面',
      screenshotBase64: after.success ? after.screenshotBase64 : undefined,
      outcome: {
        status: after.success ? 'ok' : 'skip',
        detail: after.success ? '已完成点击并保存发送后截图' : after.error
      }
    })
    this.callbacks.log('reply', `已发送微信好友申请：${request.account}`)
    this.preparedRequest = null
  }

  cancel(): void {
    this.preparedRequest = null
  }

  /**
   * 全自动流程：搜索 → 打开申请表单 → 填写验证消息与备注 → 直接发送 → 读取当前
   * 登录账号的微信号。不再需要人工确认。
   */
  async run(request: AddWechatFriendRequest): Promise<{ account: string; wechatId: string | null }> {
    await this.prepare(request)
    this.assertNotStopped()
    await this.confirm()
    this.assertNotStopped()

    let wechatId: string | null = null
    try {
      wechatId = await this.readCurrentWechatId()
    } catch (error) {
      if (error instanceof WechatFriendStoppedError) throw error

      const message = error instanceof Error ? error.message : String(error)
      this.callbacks.log('skip', `读取当前微信号失败：${message}`)
      this.callbacks.trace({
        phase: 'verify',
        summary: '读取当前微信号失败',
        outcome: { status: 'skip', detail: message }
      })
    }
    return { account: request.account, wechatId }
  }

  /**
   * 读取当前登录微信账号的微信号（added_by_wechat 用）。
   *
   * 点击主窗口左上角当前用户头像，打开个人资料卡，再让 VLM 从截图中读出“微信号”。
   */
  private async readCurrentWechatId(): Promise<string | null> {
    await this.focusWechatWindow()
    await sleep(400)

    try {
      const avatar = await this.locateTarget(
        '当前用户头像',
        '请定位微信主窗口最左侧导航栏顶部的当前登录用户头像（通常在窗口左上角）。只输出头像内部可点击位置：<point>x,y</point>。如果看不到头像，输出 [NOT_FOUND]。',
        { initialDelayMs: 300, timeoutMs: 10000 }
      )
      await this.clickLocated('点击当前用户头像', avatar)
      await sleep(800)

      const capture = await captureWechatWindow('wechat', undefined, {
        mode: 'screen',
        bypassCache: true,
        includeRelatedWindows: true
      })
      if (!capture.success || !capture.screenshotBase64) {
        throw new Error(capture.error || '读取微信个人资料截图失败')
      }
      this.callbacks.trace({
        phase: 'observe',
        summary: '观察微信个人资料卡',
        screenshotBase64: capture.screenshotBase64,
        outcome: { status: 'ok', detail: `实时截图方式：${capture.captureMethod || 'unknown'}` }
      })

      const rawResponse = await this.aiClient.detectVision(
        '请在截图中找到当前登录用户的“微信号”。只输出 <wechat_id>微信号</wechat_id>，不要输出其他任何内容。如果截图里看不到微信号，输出 [NOT_FOUND]。',
        capture.screenshotBase64
      )
      const wechatId = parseWechatId(rawResponse)
      this.callbacks.trace({
        phase: 'think',
        summary: '识别当前微信号',
        reasoning: { content: rawResponse.slice(0, 300) },
        outcome: { status: wechatId ? 'ok' : 'fail', detail: wechatId ?? undefined }
      })
      return wechatId
    } finally {
      // 无论识别成功与否，都关闭个人资料卡弹窗，避免遮挡下一轮添加好友时的搜索框。
      await this.closeWechatPopup()
    }
  }

  /**
   * 检测并确保微信主窗口处于可操作的前台状态。
   *
   * getWechatWindowInfo 内部已经负责识别主窗口并在最小化/隐藏到托盘时自动还原（带轮询
   * 校验），这里不再重复还原，只做一次兜底确认：若窗口仍处于最小化或不可见，再尝试还原
   * 一次并置前；若还失败则抛出明确错误提示用户手动打开，而不是静默地用空白截图继续跑。
   * 注意只在检测到最小化/隐藏时才还原，避免把已最大化或正常状态的窗口误“还原”成固定尺寸。
   */
  private async focusWechatWindow(): Promise<void> {
    const info = await getWechatWindowInfo('wechat', { bypassCache: true })
    if (!info?.wechatWindow) throw new Error('未找到微信窗口，请先登录并打开微信主窗口')

    const window = info.wechatWindow
    const bounds = window.getBounds?.()
    if (isMinimizedBounds(bounds) || !window.isVisible?.()) {
      this.callbacks.log('thinking', '检测到微信窗口已最小化，正在自动还原窗口')
      this.callbacks.trace({
        phase: 'act',
        summary: '还原最小化的微信窗口',
        outcome: { status: 'skip', detail: '检测到窗口处于最小化或隐藏状态' }
      })
      try {
        window.restore?.()
        window.show?.()
        window.bringToTop?.()
      } catch (error) {
        console.error('[focusWechatWindow] 还原微信窗口失败', error)
      }
      await sleep(600)
    } else {
      try {
        window.bringToTop?.()
      } catch (error) {
        console.error('[focusWechatWindow] 置前微信窗口失败', error)
      }
    }

    // 兜底校验：bounds 仍在屏幕外说明自动还原失败，直接报错提示用户，避免后续用错误的
    // 坐标截图导致目标一直识别不到。
    if (isMinimizedBounds(window.getBounds?.())) {
      throw new Error('微信窗口已最小化且自动还原失败，请手动打开微信窗口后重试')
    }

    // 等待窗口内容渲染完成，避免截图仍为空白。
    await sleep(300)
  }

  private async clickLocated(summary: string, target: LocatedTarget): Promise<void> {
    const start = Date.now()
    await humanLikeClickAt(target.point[0], target.point[1])
    this.callbacks.trace({
      phase: 'act',
      summary,
      screenshotBase64: target.screenshot,
      action: { kind: 'click', target: target.point },
      outcome: { status: 'ok', latencyMs: Date.now() - start }
    })
    await sleep(350)
  }

  /**
   * 打开“添加朋友”弹窗：点击主窗口顶部「➕」按钮，再点下拉菜单里的「添加朋友」。
   *
   * 这是更稳定的入口：不再依赖会话列表顶部搜索框的“网络查找手机/QQ号”下拉行，
   * 该行高度会随搜索结果变化导致固定坐标点不中。
   */
  private async openAddFriendEntry(): Promise<void> {
    this.callbacks.log('thinking', '正在通过「➕ → 添加朋友」打开添加朋友弹窗')

    const plusTarget = await this.locateTarget(
      '加号按钮',
      '请定位微信主窗口顶部的“➕”加号按钮，它通常位于顶部搜索框右侧。只输出该按钮内部可点击位置：<point>x,y</point>。',
      { initialDelayMs: 300, timeoutMs: 10000 }
    )
    await this.clickLocated('点击加号按钮', plusTarget)
    this.assertNotStopped()

    const menuTarget = await this.locateTarget(
      '添加朋友菜单项',
      '点击“➕”后弹出了下拉菜单，通常包含“发起群聊”“添加朋友”“扫一扫”“收付款”等项。请定位其中的“添加朋友”菜单项。只输出该菜单项内部可点击位置：<point>x,y</point>。如果下拉菜单尚未弹出，输出 [WAITING]。',
      { initialDelayMs: 400, retryIntervalMs: 600, timeoutMs: 8000 }
    )
    await this.clickLocated('点击“添加朋友”菜单项', menuTarget)
    this.assertNotStopped()

    await this.waitForAddFriendPopup()
  }

  /**
   * 校验“添加朋友”弹窗已经打开：优先通过窗口列表检测标题为“添加朋友”的独立弹窗，
   * 检测不到时退化为视觉确认，避免把主窗口误当成弹窗后白跑后续步骤。
   */
  private async waitForAddFriendPopup(): Promise<void> {
    for (let attempt = 1; attempt <= 6; attempt++) {
      this.assertNotStopped()
      if (findWechatPopupWindow(['添加朋友'])) return
      await sleep(400)
    }

    try {
      await this.locateTarget(
        '添加朋友弹窗',
        '请判断微信界面是否已经打开“添加朋友”窗口：顶部有一个搜索框（占位文字通常为“微信号/手机号”），下方显示“我的微信号”和二维码等。如果是，输出界面内任意可点击位置：<point>x,y</point>；如果不是，输出 [NOT_FOUND]。',
        { timeoutMs: 4000, retryIntervalMs: 500 }
      )
    } catch {
      throw new Error('多次尝试后仍未打开“添加朋友”弹窗')
    }
  }

  /**
   * 在“添加朋友”弹窗内点击搜索框、粘贴帐号并回车触发搜索。
   *
   * 与旧路径（会话列表顶部搜索框 + “网络查找手机/QQ号”下拉行）不同：这里直接输
   * 微信号回车，回车后弹窗内会直接出现资料卡与“添加到通讯录”按钮。点击搜索框可能
   * 发生坐标漂移导致输入落空，因此输入后校验一次搜索是否生效，未生效则重新点击。
   */
  private async fillAddFriendSearchBox(account: string): Promise<LocatedTarget> {
    const maxAttempts = 3
    let lastTarget: LocatedTarget | null = null
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      this.assertNotStopped()
      lastTarget = await this.locateTarget(
        '添加朋友搜索框',
        '请定位“添加朋友”窗口顶部的搜索输入框，占位文字通常为“微信号/手机号”。只输出该输入框内部可点击位置：<point>x,y</point>。',
        { popupTitles: FRIEND_POPUP_TITLES }
      )
      await this.clickLocated(
        attempt === 1 ? '点击添加朋友搜索框' : `重新点击添加朋友搜索框（第 ${attempt} 次）`,
        lastTarget
      )
      await replaceTextAtAction(undefined, undefined, account, false)
      await sleep(350)
      await pressEnterAction()
      this.assertNotStopped()

      if (await this.isAddFriendSearchSubmitted(account)) return lastTarget

      this.callbacks.log(
        'thinking',
        attempt < maxAttempts
          ? '添加朋友搜索未生效，疑似点击发生漂移，正在重新定位并点击'
          : '添加朋友搜索框多次尝试后仍未成功搜索'
      )
      this.callbacks.trace({
        phase: 'verify',
        summary: '校验添加朋友搜索是否生效',
        outcome: { status: 'skip', detail: `第 ${attempt} 次输入后未出现搜索结果` }
      })
    }
    throw new Error('多次尝试后仍未在“添加朋友”弹窗中成功搜索该帐号')
  }

  /** 校验“添加朋友”弹窗内是否已经出现搜索结果（资料卡或“无法找到该用户”提示）。 */
  private async isAddFriendSearchSubmitted(account: string): Promise<boolean> {
    try {
      await this.locateTarget(
        '添加朋友搜索结果校验',
        `请在“添加朋友”窗口内判断：针对“${account}”的搜索是否已经出现结果（例如显示该用户资料卡、头像和“添加到通讯录”按钮），或明确显示“无法找到该用户”“查无此人”等提示。如果出现任一结果，输出界面内任意可点击位置：<point>x,y</point>；如果仍为空或仍在搜索中，输出 [WAITING]。`,
        {
          timeoutMs: 3500,
          retryIntervalMs: 500,
          retryNotFound: false,
          popupTitles: FRIEND_POPUP_TITLES
        }
      )
      return true
    } catch {
      return false
    }
  }

  /**
   * 点击“添加到通讯录”按钮，并确认好友申请表单真的打开。
   *
   * 微信资料页里的“视频号”“朋友圈”“公众号”等入口卡片很容易被 VLM 误判成按钮。
   * 点击后校验“朋友验证/发送朋友申请”表单是否出现；若没出现（说明点到了视频号等
   * 无关弹窗），按 Esc 关闭弹窗并重新定位、重新点击，最多重试 3 次。
   */
  private async clickAddToContactsButton(): Promise<void> {
    const maxAttempts = 3
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      let addTarget: LocatedTarget
      try {
        addTarget = await this.locateTarget(
          '添加到通讯录按钮',
          '请查看当前微信用户资料页或资料弹窗，定位“添加到通讯录”按钮。它通常是一个实心绿色（或品牌色）圆角按钮，上面有白色文字“添加到通讯录”，位于资料页下方。\n\n注意：资料页中可能还有“视频号”“公众号”“朋友圈”“更多信息”等入口卡片。这些入口通常带有封面缩略图、头像或图标，是卡片样式；而“添加到通讯录”是一个纯色（绿色）实心圆角按钮，上面只有白色文字、没有封面图。两者视觉差异明显，绝对不要把带图标的入口卡片当成按钮。只输出绿色“添加到通讯录”按钮内部可点击位置：<point>x,y</point>。如果资料页或弹窗仍在加载，输出 [WAITING]；如果界面显示的是已添加好友的资料卡（包含“备注”“来源”“添加时间”等信息，下方只有“发消息”“语音聊天”“视频聊天”三个按钮而没有“添加到通讯录”按钮），输出 [ALREADY_FRIEND]；如果界面明确显示“无法找到该用户”“查无此人”等提示（说明该账号不存在，而不是没有“添加到通讯录”按钮），输出 [USER_NOT_FOUND]；如果只是看不到“添加到通讯录”按钮但没有“无法找到该用户”提示，输出 [NOT_FOUND]。',
          { initialDelayMs: attempt === 1 ? 700 : 300, timeoutMs: 15000, popupTitles: FRIEND_POPUP_TITLES }
        )
      } catch (error) {
        if (error instanceof WechatUiStateError && error.state === 'already_friend') {
          // 对方已是当前登录微信的好友：关闭资料卡弹窗，读取当前登录微信号，供上层回写“已申请过”。
          await this.closeWechatPopup()
          let currentWechatId: string | null = null
          try {
            currentWechatId = await this.readCurrentWechatId()
          } catch (readError) {
            this.callbacks.log(
              'skip',
              `该帐号已是好友，但读取当前微信号失败：${readError instanceof Error ? readError.message : String(readError)}`
            )
          }
          throw new WechatFriendAlreadyFriendError(currentWechatId)
        }
        throw error
      }

      await this.clickLocated(
        attempt === 1 ? '打开好友申请表单' : `重新打开好友申请表单（第 ${attempt} 次）`,
        addTarget
      )
      await sleep(800)

      if (await this.isAddFriendFormOpened()) return

      if (attempt < maxAttempts) {
        this.callbacks.log(
          'thinking',
          '点击“添加到通讯录”后未出现好友申请表单，可能误点了视频号等入口，正在关闭弹窗并重试'
        )
        this.callbacks.trace({
          phase: 'verify',
          summary: '疑似误点视频号等入口，关闭弹窗后重试',
          outcome: { status: 'skip', detail: `第 ${attempt} 次点击后未出现好友申请表单` }
        })
        await this.closeWechatPopup()
      }
    }
    throw new Error('多次点击“添加到通讯录”后仍未打开好友申请表单，可能误入了视频号等无关入口')
  }

  /** 判断好友申请表单（朋友验证/发送朋友申请）是否已经打开。 */
  private async isAddFriendFormOpened(): Promise<boolean> {
    try {
      await this.locateTarget(
        '好友申请表单',
        '请判断当前微信界面是否已经打开“朋友验证”或“发送朋友申请”表单。该表单通常包含“你需要发送验证申请，等待对方通过”提示、一个验证消息输入框以及“发送”按钮。如果是，输出表单内任意可点击位置：<point>x,y</point>。如果不是（例如打开的是视频号、朋友圈、公众号或其他弹窗），输出 [NOT_FOUND]。',
        { timeoutMs: 3500, retryIntervalMs: 600, retryNotFound: false, popupTitles: FRIEND_POPUP_TITLES }
      )
      return true
    } catch {
      return false
    }
  }

  /** 判断点击发送后是否出现微信风控提示（“操作过于频繁，请稍后再试”）。 */
  private async isRateLimitedAfterSend(): Promise<boolean> {
    try {
      await this.locateTarget(
        '发送后风控提示',
        '请判断当前微信界面是否出现了“操作过于频繁，请稍后再试”的提示（通常是一个弹出的提示条或小弹窗）。如果出现了，输出该提示所在位置：<point>x,y</point>；如果没有出现，输出 [NOT_FOUND]。',
        { timeoutMs: 3000, retryIntervalMs: 500, retryNotFound: false, popupTitles: FRIEND_POPUP_TITLES }
      )
      return true
    } catch {
      return false
    }
  }

  /**
   * 关闭当前弹出的无关弹窗（如视频号）。
   *
   * 视频号这类内嵌页面用 Esc 关不掉（Esc 只对普通模态弹窗生效），需要点击页面
   * 左上角的“返回/关闭”按钮才能真正退出。这里先按 Esc 兜底普通弹窗，再用视觉
   * 校验是否已经退出，未退出则定位并点击返回/关闭按钮，最多重试 3 次。
   */
  private async closeWechatPopup(): Promise<void> {
    const robot = getRobot()
    if (robot) {
      try {
        robot.keyTap('escape')
        await sleep(500)
      } catch (error) {
        console.error('[closeWechatPopup] 关闭弹窗失败', error)
      }
    }

    for (let attempt = 1; attempt <= 3; attempt++) {
      this.assertNotStopped()
      if (await this.isProfileOrMainRestored()) return
      await this.clickPopupBackButton(attempt)
    }
  }

  /** 判断是否已经退出视频号等无关页面，回到该用户的资料页或微信主界面。 */
  private async isProfileOrMainRestored(): Promise<boolean> {
    try {
      await this.locateTarget(
        '资料页恢复校验',
        '请判断当前微信界面是否已经回到该用户的资料页（包含“添加到通讯录”或“发消息”按钮）或微信主界面（包含左侧会话列表和顶部搜索框）。如果是，输出界面内任意可点击位置：<point>x,y</point>。如果仍停留在视频号页面（有视频内容、视频号标识或“关注”按钮），输出 [NOT_FOUND]。',
        { timeoutMs: 2500, retryIntervalMs: 400, retryNotFound: false }
      )
      return true
    } catch {
      return false
    }
  }

  /** 视觉定位并点击视频号页面上的“返回/关闭”按钮，退出到资料页或主界面。 */
  private async clickPopupBackButton(attempt: number): Promise<void> {
    try {
      const back = await this.locateTarget(
        '视频号返回按钮',
        '当前微信停留在视频号页面。请定位页面左上角的“返回”箭头按钮（←）或“关闭”按钮（×），用于退出视频号回到资料页。只输出该按钮内部可点击位置：<point>x,y</point>。如果找不到返回或关闭按钮，输出 [NOT_FOUND]。',
        { timeoutMs: 4000, retryIntervalMs: 600, retryNotFound: false }
      )
      await this.clickLocated(
        attempt === 1 ? '点击返回退出视频号' : `再次点击返回退出视频号（第 ${attempt} 次）`,
        back
      )
    } catch {
      const robot = getRobot()
      try {
        robot?.keyTap('escape')
      } catch (error) {
        console.error('[clickPopupBackButton] 兜底关闭失败', error)
      }
      await sleep(500)
    }
  }

  private async locateAndFill(
    name: string,
    prompt: string,
    text: string,
    summary: string,
    optional = false,
    popupTitles?: string[]
  ): Promise<void> {
    try {
      const target = await this.locateTarget(name, prompt, {
        ...(optional ? { timeoutMs: 0, retryNotFound: false } : {}),
        ...(popupTitles?.length ? { popupTitles } : {})
      })
      const start = Date.now()
      await replaceTextAtAction(target.point[0], target.point[1], text, false)
      this.callbacks.trace({
        phase: 'act',
        summary,
        screenshotBase64: target.screenshot,
        action: { kind: 'input', target: target.point, payload: text },
        outcome: { status: 'ok', latencyMs: Date.now() - start }
      })
    } catch (error) {
      const canSkip = optional && error instanceof WechatUiStateError && error.state === 'not_found'
      if (!canSkip) throw error

      this.callbacks.log('skip', `${name}未找到，已跳过该可选字段`)
      this.callbacks.trace({
        phase: 'verify',
        summary: `${name}未找到，跳过可选字段`,
        outcome: { status: 'skip', detail: error.message }
      })
    }
  }

  private async locateTarget(
    name: string,
    prompt: string,
    options: LocateTargetOptions = {}
  ): Promise<LocatedTarget> {
    const timeoutMs = options.timeoutMs ?? 10000
    const retryIntervalMs = options.retryIntervalMs ?? 800
    const retryNotFound = options.retryNotFound ?? true
    const deadline = Date.now() + timeoutMs
    let attempt = 0
    let lastError: unknown

    if (options.initialDelayMs) await sleep(options.initialDelayMs)

    while (true) {
      this.assertNotStopped()
      attempt += 1
      try {
        return await this.locateTargetOnce(name, prompt, options)
      } catch (error) {
        if (error instanceof WechatFriendStoppedError) throw error

        const isWaiting =
          error instanceof WechatUiStateError &&
          (error.state === 'waiting' || (retryNotFound && error.state === 'not_found'))
        const isNotReady = error instanceof WechatTargetNotReadyError
        if (!isWaiting && !isNotReady) throw error

        lastError = error
        const remainingMs = deadline - Date.now()
        if (timeoutMs <= 0 || remainingMs <= 0) break

        const waitMs = Math.min(retryIntervalMs, remainingMs)
        this.callbacks.log(
          'thinking',
          `${name}尚未出现，${waitMs}ms 后重新截图识别（第 ${attempt} 次）`
        )
        this.callbacks.trace({
          phase: 'verify',
          summary: `等待动态界面：${name}`,
          action: { kind: 'wait', payload: `${waitMs}ms 后重新截图识别` },
          outcome: {
            status: 'skip',
            detail: error instanceof Error ? error.message : String(error)
          }
        })
        await sleep(waitMs)
      }
    }

    const detail = lastError instanceof Error ? lastError.message : String(lastError || '')
    throw new Error(`等待微信界面“${name}”出现超时${detail ? `：${detail}` : ''}`)
  }

  private async locateTargetOnce(
    name: string,
    prompt: string,
    options: LocateTargetOptions = {}
  ): Promise<LocatedTarget> {
    this.callbacks.log('thinking', `正在识别：${name}`)

    // 优先通过窗口列表检测微信独立弹窗（如“添加朋友”“朋友验证”），只截这个弹窗区域：
    // 弹窗可能落在主窗口像素区域之外，主窗口合成截图会漏掉它；而聚焦弹窗截图能让按钮
    // 占据更大比例，归一化坐标更准。检测不到弹窗时退回主窗口合成截图兜底。
    let capture: any = null
    if (options.popupTitles?.length) {
      const popup = findWechatPopupWindow(options.popupTitles)
      if (popup) {
        this.callbacks.log('thinking', `检测到微信弹窗「${popup.title}」，正在截取该弹窗区域`)
        const region = await captureScreenRegion(popup.bounds)
        if (region.success && region.screenshotBase64 && region.display) {
          capture = {
            success: true,
            screenshotBase64: region.screenshotBase64,
            bounds: popup.bounds,
            display: { id: region.display.id, scaleFactor: region.display.scaleFactor },
            captureMethod: 'popup-region'
          }
        }
      }
    }

    if (!capture?.success) {
      capture = await captureWechatWindow('wechat', undefined, {
        mode: 'screen',
        bypassCache: true,
        includeRelatedWindows: true
      })
    }

    if (!capture.success || !capture.screenshotBase64 || !capture.bounds || !capture.display) {
      throw new Error(capture.error || '微信窗口截图失败')
    }

    this.callbacks.trace({
      phase: 'observe',
      summary: `观察微信界面：${name}`,
      screenshotBase64: capture.screenshotBase64,
      outcome: {
        status: 'ok',
        detail: `实时截图方式：${capture.captureMethod || 'unknown'}`
      }
    })

    const startedAt = Date.now()
    const rawResponse = await this.aiClient.detectVision(
      `${prompt}\n\n要求：坐标必须基于整张截图，左上角为 0,0，右下角为 1000,1000；只有目标真实可见时才能输出坐标。如果目标尚未出现、仍在加载、下拉框未展开或弹窗未打开，输出 [WAITING]，不要猜测坐标；不要解释。`,
      capture.screenshotBase64
    )
    const point = parsePoint(rawResponse)
    const specialState = parseSpecialState(rawResponse)
    this.callbacks.trace({
      phase: 'think',
      summary: `视觉定位：${name}`,
      reasoning: { content: rawResponse.slice(0, 600) },
      outcome: {
        status: point
          ? 'ok'
          : specialState === 'already_friend' ||
              specialState === 'already_sent' ||
              specialState === 'waiting' ||
              specialState === 'user_not_found'
            ? 'skip'
            : 'fail',
        detail: point ? undefined : rawResponse.slice(0, 300),
        latencyMs: Date.now() - startedAt
      }
    })

    if (!point) {
      if (specialState === 'already_friend') {
        throw new WechatUiStateError('already_friend', '该帐号已经是微信好友')
      }
      if (specialState === 'already_sent') {
        throw new WechatUiStateError('already_sent', '好友申请已经发送')
      }
      if (specialState === 'waiting') {
        throw new WechatUiStateError('waiting', `${name}仍在加载`)
      }
      if (specialState === 'user_not_found') {
        throw new WechatFriendUserNotFoundError()
      }
      if (specialState === 'not_found') {
        throw new WechatUiStateError('not_found', `微信界面中未找到${name}`)
      }
      throw new WechatTargetNotReadyError(`${name}视觉定位结果无有效坐标`)
    }

    const screenPoint = pointToScreenCoords(point, capture.bounds, capture.display.scaleFactor || 1)
    return { point: screenPoint, screenshot: capture.screenshotBase64, rawResponse }
  }
}

function parseSpecialState(rawResponse: string): WechatUiState | null {
  if (/\[ALREADY_FRIEND\]/i.test(rawResponse)) return 'already_friend'
  if (/\[ALREADY_SENT\]/i.test(rawResponse)) return 'already_sent'
  if (/\[WAITING\]/i.test(rawResponse)) return 'waiting'
  if (/\[USER_NOT_FOUND\]/i.test(rawResponse)) return 'user_not_found'
  if (/\[NOT_FOUND\]/i.test(rawResponse)) return 'not_found'
  return null
}

function parseWechatId(rawResponse: string): string | null {
  const tag = /<wechat_id>\s*([^<\s][^<]*?)\s*<\/wechat_id>/i.exec(rawResponse)
  if (tag?.[1]) {
    const value = tag[1].trim()
    if (value) return value
  }
  // 兜底：直接匹配“微信号：xxx”这类文本。
  const label = /微信号\s*[:：]\s*([A-Za-z0-9_-]{4,32})/i.exec(rawResponse)
  if (label?.[1]) return label[1]
  return null
}

function normalizeRequest(raw: AddWechatFriendRequest): AddWechatFriendRequest {
  const account = String(raw?.account || '').trim()
  if (!account) throw new Error('微信号或手机号不能为空')
  if (account.length > 64 || /[\r\n]/.test(account)) {
    throw new Error('微信号或手机号格式不正确')
  }

  const verificationMessage = String(raw?.verificationMessage || '')
    .trim()
    .slice(0, 120)
  const remark = String(raw?.remark || '')
    .trim()
    .slice(0, 64)
  return {
    account,
    verificationMessage: verificationMessage || undefined,
    remark: remark || undefined
  }
}
