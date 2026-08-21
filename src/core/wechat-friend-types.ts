export interface AddWechatFriendRequest {
  /** 微信号、手机号或可被微信搜索到的帐号。 */
  account: string
  /** 好友申请中的验证消息。 */
  verificationMessage?: string
  /** 添加好友时设置的备注。 */
  remark?: string
}

/** 后端客户记录（GET /api/pending 返回的字段）。 */
export interface WechatFriendCustomer {
  id: number
  name: string
  wechat: string
  channel: string
  status: string
  remark?: string
  note?: string
  created_at?: string
  added_at?: string
  verified_at?: string
  added_by_wechat?: string | null
}

/** 自动添加的运行模式：single 一次一个，continuous 持续添加直到没有待添加客户或人工停止。 */
export type WechatFriendAddMode = 'single' | 'continuous'

/** 一次自动添加的最终结果。 */
export interface WechatFriendAutoResult {
  success: boolean
  stage: WechatFriendOperationStage
  customer?: WechatFriendCustomer
  wechatId?: string | null
  /** continuous 模式下本次累计成功添加的数量。 */
  addedCount?: number
  /** continuous 模式下本次累计因“无法找到该用户”而跳过的数量。 */
  skippedCount?: number
  error?: string
  detail?: string
}

export type WechatFriendOperationStage =
  | 'idle'
  | 'preparing'
  | 'awaiting_confirmation'
  | 'sending'
  | 'completed'
  | 'cancelled'
  | 'failed'

export interface WechatFriendOperationStatus {
  stage: WechatFriendOperationStage
  account?: string
  sessionId?: string | null
  detail?: string
}

export interface WechatFriendOperationResult {
  success: boolean
  stage: WechatFriendOperationStage
  error?: string
  detail?: string
}
