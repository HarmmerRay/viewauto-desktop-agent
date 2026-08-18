const DEFAULT_MODEL = 'doubao-seed-2-0-lite-260215'
const DEFAULT_BASE_URL = 'https://ark.cn-beijing.volces.com/api/v3'
const DEFAULT_PROMPT = `你是一个微信自动回复助手。你会收到一张微信/企业微信的聊天窗口截图。

## 你的任务
分析截图中的聊天内容，生成合适的回复。

## 规则
1. 只输出回复文字，不要解释、不要添加多余内容
2. 防自我循环：仔细观察截图。聊天窗口中，右侧的气泡是"我"发送的。如果最后一条消息是右侧气泡，必须输出 [SKIP]
3. 如果最新消息是系统消息、群公告、红包、转账等非对话消息，输出 [SKIP]
4. 如果无法判断是否需要回复，输出 [SKIP]
5. 回复要自然、口语化，像真人对话`

export const manifest = {
  id: 'volcengine-ark',
  apiVersion: 1
}

export function createProvider(context) {
  const providerConfig = context && context.providerConfig ? context.providerConfig : {}

  return {
    async *run(input) {
      if (!input || !input.screenshot) {
        yield { type: 'skip' }
        return
      }

      const apiKey = String(providerConfig.apiKey || '').trim()
      if (!apiKey) {
        yield { type: 'error', error: '回复模型缺少 API Key' }
        return
      }

      const memorySection = buildMemorySection(input.memoryCards)
      yield {
        type: 'thinking',
        content: memorySection
          ? `正在分析聊天内容（已加载 ${input.memoryCards.length} 条团队经验）...`
          : '正在分析聊天内容...'
      }

      try {
        const reply = await requestReply({
          screenshot: input.screenshot,
          apiKey,
          baseURL: providerConfig.baseURL || DEFAULT_BASE_URL,
          model: providerConfig.model || DEFAULT_MODEL,
          systemPrompt: (providerConfig.systemPrompt || DEFAULT_PROMPT) + memorySection
        })

        if (!reply || reply.trim() === '[SKIP]') {
          yield { type: 'skip' }
          return
        }

        yield { type: 'reply_text', content: reply.trim() }
      } catch (error) {
        const message = error && error.message ? error.message : String(error)
        if (context && context.host && typeof context.host.log === 'function') {
          context.host.log(`provider error: ${message}`)
        }
        yield { type: 'error', error: message || '回复模型调用失败' }
      }
    }
  }
}

async function requestReply({ screenshot, apiKey, baseURL, model, systemPrompt }) {
  const body = {
    model,
    messages: [
      { role: 'system', content: systemPrompt },
      {
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: normalizeImageUrl(screenshot) } },
          { type: 'text', text: '请根据截图中微信聊天窗口的最新消息进行回复。' }
        ]
      }
    ],
    stream: false
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 30_000)
  let response
  try {
    response = await fetch(buildChatCompletionsUrl(baseURL), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body),
      signal: controller.signal
    })
  } catch (error) {
    if (error && error.name === 'AbortError') {
      throw new Error('回复模型请求超时（30 秒）')
    }
    throw error
  } finally {
    clearTimeout(timer)
  }

  if (!response.ok) {
    const errorText = await response.text().catch(() => '')
    throw new Error(
      `API request failed: ${response.status} ${response.statusText}${errorText ? ` - ${errorText.slice(0, 300)}` : ''}`
    )
  }

  const json = await response.json()
  return extractResponseText(json)
}

function buildChatCompletionsUrl(baseURL) {
  const normalized = String(baseURL || DEFAULT_BASE_URL).trim().replace(/\/+$/, '')
  if (!normalized) return `${DEFAULT_BASE_URL}/chat/completions`
  return normalized.endsWith('/chat/completions')
    ? normalized
    : `${normalized}/chat/completions`
}

function extractResponseText(json) {
  const content = json && json.choices && json.choices[0] && json.choices[0].message
    ? json.choices[0].message.content
    : ''
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((part) => (part && typeof part.text === 'string' ? part.text : ''))
      .join('')
  }
  return ''
}

// 工作记忆注入：把运行时下发的经验卡片拼成 system prompt 附加段
function buildMemorySection(memoryCards) {
  if (!Array.isArray(memoryCards) || memoryCards.length === 0) {
    return ''
  }
  const lines = memoryCards.map((card, index) => {
    const rationale = card.rationale ? `（原因：${card.rationale}）` : ''
    return `${index + 1}. 【${card.scenario}】${card.guidance}${rationale}`
  })
  return `\n\n## 团队经验（来自工作记忆，优先遵循）\n${lines.join('\n')}`
}

function normalizeImageUrl(screenshot) {
  const rawBase64 = stripBase64Prefix(screenshot)
  if (rawBase64.startsWith('http')) {
    return rawBase64
  }
  return `data:image/png;base64,${rawBase64}`
}

function stripBase64Prefix(base64) {
  const idx = String(base64).indexOf('base64,')
  return idx !== -1 ? String(base64).slice(idx + 'base64,'.length) : String(base64)
}