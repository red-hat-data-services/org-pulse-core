import { ref, triggerRef } from 'vue'

const TYPING_INTERVAL_MS = 12
const TOOL_MIN_SPIN_MS = 500

export function useChat() {
  const messages = ref([])
  const isStreaming = ref(false)
  const error = ref(null)
  let context = null

  let _pendingText = ''
  let _typingTimer = null
  let _assistantIdx = -1
  let _deferredTrace = null

  function _startTyping() {
    if (_typingTimer) return
    _typingTimer = setTimeout(_tick, TYPING_INTERVAL_MS)
  }

  function _tick() {
    _typingTimer = null
    if (!_pendingText || _assistantIdx < 0) return

    const msg = messages.value[_assistantIdx]
    if (!msg) return

    const chars = Math.max(1, Math.ceil(_pendingText.length / 30))
    msg.content += _pendingText.slice(0, chars)
    _pendingText = _pendingText.slice(chars)
    triggerRef(messages)

    if (_pendingText.length > 0) {
      _typingTimer = setTimeout(_tick, TYPING_INTERVAL_MS)
    } else if (_deferredTrace) {
      msg.trace = _deferredTrace
      _deferredTrace = null
      triggerRef(messages)
    }
  }

  function _flush() {
    if (_typingTimer) {
      clearTimeout(_typingTimer)
      _typingTimer = null
    }
    _pendingText = ''
    _deferredTrace = null
  }

  function buildHistory() {
    return messages.value.map(m => ({
      role: m.role,
      content: m.content,
      used_tools: m.toolCalls?.length > 0 || false,
    }))
  }

  async function sendMessage(text) {
    if (!text.trim() || isStreaming.value) return

    _flush()
    error.value = null
    messages.value.push({ role: 'user', content: text })
    messages.value.push({ role: 'assistant', content: '', toolCalls: [], trace: null })
    _assistantIdx = messages.value.length - 1
    isStreaming.value = true

    try {
      const response = await fetch('/api/modules/chatbot/chat/stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: text,
          history: buildHistory().slice(0, -2),
          context,
        }),
      })

      if (!response.ok) {
        throw new Error(`Server error: ${response.status}`)
      }

      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''

      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop()

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue
          const payload = line.slice(6)
          if (!payload) continue

          try {
            const event = JSON.parse(payload)
            const msg = messages.value[_assistantIdx]

            if (event.type === 'token') {
              _pendingText += event.content
              _startTyping()
            } else if (event.type === 'content_replace') {
              const alreadyTyped = msg.content
              const finalContent = event.content
              if (finalContent.startsWith(alreadyTyped)) {
                _pendingText = finalContent.slice(alreadyTyped.length)
              } else {
                _pendingText = finalContent
                msg.content = ''
                triggerRef(messages)
              }
              _deferredTrace = event.trace || null
              if (event.context !== undefined) {
                context = event.context
              }
              _startTyping()
            } else if (event.type === 'tool_call') {
              msg.toolCalls.push({
                tool: event.tool,
                arguments: event.arguments,
                status: 'running',
                _startedAt: Date.now(),
              })
              triggerRef(messages)
            } else if (event.type === 'tool_result') {
              const tc = msg.toolCalls.find(
                t => t.tool === event.tool && t.status === 'running'
              )
              if (tc) {
                tc.status = 'completing'
                tc.duration_ms = event.duration_ms ?? null
                const elapsed = Date.now() - (tc._startedAt || 0)
                if (elapsed >= TOOL_MIN_SPIN_MS) {
                  tc.status = 'done'
                  triggerRef(messages)
                } else {
                  setTimeout(() => {
                    tc.status = 'done'
                    triggerRef(messages)
                  }, TOOL_MIN_SPIN_MS - elapsed)
                }
              }
            } else if (event.type === 'error') {
              _flush()
              msg.content = event.content
              triggerRef(messages)
            }
          } catch {
            // skip malformed SSE lines
          }
        }
      }
    } catch (err) {
      _flush()
      error.value = err.message
      const msg = messages.value[_assistantIdx]
      if (msg) {
        msg.content = msg.content || 'Something went wrong. Please try again.'
        triggerRef(messages)
      }
    } finally {
      isStreaming.value = false
    }
  }

  function clearMessages() {
    _flush()
    _assistantIdx = -1
    messages.value = []
    context = null
    error.value = null
  }

  return { messages, isStreaming, error, sendMessage, clearMessages }
}
