import { AIClient } from './ai-client'
import { humanLikeClickAt, replaceTextAtAction } from './rpa/input-utils'
import { captureWechatWindow } from './rpa/screenshot-utils'
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

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

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

    const inputStartedAt = Date.now()
    const searchTarget = await this.fillSearchBox(request.account)
    this.assertNotStopped()
    this.callbacks.trace({
      phase: 'act',
      summary: '输入待添加的微信帐号',
      screenshotBase64: searchTarget.screenshot,
      action: { kind: 'input', target: searchTarget.point, payload: request.account },
      outcome: { status: 'ok', latencyMs: Date.now() - inputStartedAt }
    })

    // 不直接按回车，避免微信把第一个本地聊天记录当成搜索目标。
    // 微信的网络搜索结果是异步出现的：后续定位会持续重新截图，直到结果真正出现。
    await this.locateAndClick(
      '网络搜索结果',
      `当前微信搜索框中已经输入“${request.account}”。请定位用于通过网络查找该微信号或手机号的可点击结果；它可能显示为“网络查找微信号/手机号：${request.account}”、带放大镜的搜索项，或明确匹配到的用户资料卡。不要点击本地聊天记录。只输出目标结果内部的可点击位置：<point>x,y</point>。如果搜索结果下拉区域尚未出现或仍在加载，输出 [WAITING]；只有界面明确显示“无法找到该用户”“查无此人”等提示时才输出 [USER_NOT_FOUND]。`,
      {
        initialDelayMs: 700,
        retryIntervalMs: 900,
        timeoutMs: 20000
      }
    )

    await this.clickAddToContactsButton()
    this.assertNotStopped()

    await sleep(400)
    if (request.verificationMessage) {
      await this.locateAndFill(
        '验证消息输入框',
        '请定位微信“朋友验证”或“发送朋友申请”表单中的验证消息输入框。它通常位于“你需要发送验证申请，等待对方通过”提示下方。只输出输入框内部可点击位置：<point>x,y</point>。',
        request.verificationMessage,
        '填写好友验证消息'
      )
    }

    if (request.remark) {
      await this.locateAndFill(
        '备注输入框',
        '请定位当前好友申请表单中的“备注”“备注名”输入框。只输出输入框内部可点击位置：<point>x,y</point>。如果当前表单没有备注输入框，输出 [NOT_FOUND]。',
        request.remark,
        '填写好友备注',
        true
      )
    }

    await sleep(400)
    this.assertNotStopped()
    const finalTarget = await this.locateTarget(
      '最终发送按钮',
      '请定位当前微信好友申请表单中会真正提交申请的“发送”“确定”或“完成”按钮。只输出按钮内部可点击位置：<point>x,y</point>。不要执行点击。'
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
        '当前应当停留在微信好友申请表单。请定位会真正提交申请的“发送”“确定”或“完成”按钮。只输出按钮内部可点击位置：<point>x,y</point>。如果当前已经显示申请已发送，输出 [ALREADY_SENT]。'
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
   * 检测微信主窗口是否可操作。
   *
   * 与消息监控一致：只读取窗口当前实际打开的位置，不做任何置前/还原/移动操作。
   * 之前这里无条件调用 restore()/show()/bringToTop()，会把最大化状态的微信窗口
   * “还原”成固定尺寸和位置（restore() 即 ShowWindow SW_RESTORE，会取消最大化并
   * 回到保存的位置），导致用户看到的窗口被强行固定到某个地方。现已移除。
   *
   * 窗口若确实处于最小化状态，getWechatWindowInfo 内部会做最小化还原（必要的兜底，
   * 否则截图是空白），这与消息监控共用同一套逻辑。
   */
  private async focusWechatWindow(): Promise<void> {
    const info = await getWechatWindowInfo('wechat', { bypassCache: true })
    if (!info?.wechatWindow) throw new Error('未找到微信窗口，请先登录并打开微信主窗口')
    await sleep(250)
  }

  private async locateAndClick(
    name: string,
    prompt: string,
    options?: LocateTargetOptions
  ): Promise<LocatedTarget> {
    const target = await this.locateTarget(name, prompt, options)
    await this.clickLocated(`点击${name}`, target)
    return target
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
   * 点击并聚焦搜索框，输入帐号后校验搜索框内确实出现了该帐号文本。
   *
   * 点击搜索框可能发生坐标漂移（点偏），导致后续输入落到别处、搜索框未获得焦点；
   * 此时直接进入“等待搜索结果”的重试会永远等不到结果。这里在输入后校验一次，若未
   * 成功输入则重新定位并点击，最多重试 3 次，避免无效的 900ms 空转。
   */
  private async fillSearchBox(account: string): Promise<LocatedTarget> {
    const maxAttempts = 3
    let lastTarget: LocatedTarget | null = null
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      this.assertNotStopped()
      lastTarget = await this.locateTarget(
        '微信搜索框',
        '请定位微信主窗口左侧会话列表顶部的搜索输入框。它通常带有“搜索”占位文字或放大镜图标。只输出该输入框内部可点击位置：<point>x,y</point>，坐标范围 0-1000。'
      )
      await this.clickLocated(
        attempt === 1 ? '点击微信搜索框' : `重新点击微信搜索框（第 ${attempt} 次）`,
        lastTarget
      )
      await replaceTextAtAction(undefined, undefined, account, false)
      this.assertNotStopped()

      if (await this.isSearchBoxFilled(account)) return lastTarget

      this.callbacks.log(
        'thinking',
        attempt < maxAttempts
          ? '搜索框未成功输入帐号，疑似点击发生漂移，正在重新定位并点击'
          : '搜索框多次尝试后仍未成功输入帐号'
      )
      this.callbacks.trace({
        phase: 'verify',
        summary: '校验搜索框输入结果',
        outcome: { status: 'skip', detail: `第 ${attempt} 次输入后搜索框未出现目标文本` }
      })
    }
    throw new Error('多次点击搜索框后仍未成功输入帐号，搜索框可能未获得焦点')
  }

  /** 校验搜索框内是否已经成功输入指定帐号文本。 */
  private async isSearchBoxFilled(account: string): Promise<boolean> {
    try {
      await this.locateTarget(
        '搜索框输入校验',
        `请判断微信主窗口顶部搜索输入框中是否已经显示文本“${account}”（重点看输入框内已输入的文本，而不是下方展开的搜索结果）。如果输入框内确实已显示该文本，输出输入框内部任意位置：<point>x,y</point>；如果输入框为空或文本不一致，输出 [NOT_FOUND]。`,
        { timeoutMs: 3000, retryIntervalMs: 500, retryNotFound: false }
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
          '请查看当前微信用户资料页或资料弹窗，定位“添加到通讯录”按钮。它通常是一个实心绿色（或品牌色）圆角按钮，上面有白色文字“添加到通讯录”，位于资料页下方。\n\n注意：资料页中可能还有“视频号”“公众号”“朋友圈”“更多信息”等入口卡片，它们不是“添加到通讯录”按钮，绝对不要定位或点击这些入口。只输出绿色“添加到通讯录”按钮内部可点击位置：<point>x,y</point>。如果资料页或弹窗仍在加载，输出 [WAITING]；如果界面明确表明对方已经是好友并只显示“发消息”，输出 [ALREADY_FRIEND]；如果界面明确显示“无法找到该用户”“查无此人”等提示（说明该账号不存在，而不是没有“添加到通讯录”按钮），输出 [USER_NOT_FOUND]；如果只是看不到“添加到通讯录”按钮但没有“无法找到该用户”提示，输出 [NOT_FOUND]。',
          { initialDelayMs: attempt === 1 ? 700 : 300, timeoutMs: 15000 }
        )
      } catch (error) {
        if (error instanceof WechatUiStateError && error.state === 'already_friend') {
          throw new Error('该帐号已经是微信好友')
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
        { timeoutMs: 3500, retryIntervalMs: 600, retryNotFound: false }
      )
      return true
    } catch {
      return false
    }
  }

  /** 按 Esc 关闭当前弹出的无关弹窗（如视频号）。 */
  private async closeWechatPopup(): Promise<void> {
    const robot = getRobot()
    if (!robot) return
    try {
      robot.keyTap('escape')
      await sleep(500)
    } catch (error) {
      console.error('[closeWechatPopup] 关闭弹窗失败', error)
    }
  }

  private async locateAndFill(
    name: string,
    prompt: string,
    text: string,
    summary: string,
    optional = false
  ): Promise<void> {
    try {
      const target = await this.locateTarget(
        name,
        prompt,
        optional ? { timeoutMs: 0, retryNotFound: false } : undefined
      )
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
        return await this.locateTargetOnce(name, prompt)
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

  private async locateTargetOnce(name: string, prompt: string): Promise<LocatedTarget> {
    this.callbacks.log('thinking', `正在识别：${name}`)
    const capture = await captureWechatWindow('wechat', undefined, {
      mode: 'screen',
      bypassCache: true,
      includeRelatedWindows: true
    })
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
      `${prompt}\n\n要求：坐标必须基于整张截图（截图可能同时包含微信主窗口和独立弹窗，例如“添加朋友”对话框），左上角为 0,0，右下角为 1000,1000；只有目标真实可见时才能输出坐标。如果目标尚未出现、仍在加载、下拉框未展开或弹窗未打开，输出 [WAITING]，不要猜测坐标；不要解释。`,
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
