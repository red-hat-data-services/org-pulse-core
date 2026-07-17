/**
 * @param {import('express').Router} router
 * @param {import('@shared/server/module-context').ModuleContext} context
 */
module.exports = function registerRoutes(router, context) {
  const { requireAuth, secrets, logger } = context

  const MAX_MESSAGE_LENGTH = 4000
  const MAX_HISTORY_MESSAGES = 50

  function getServiceUrl() {
    return (secrets.CHATBOT_SERVICE_URL || '').replace(/\/$/, '')
  }

  function validateChatBody(body) {
    if (!body || typeof body.message !== 'string' || !body.message.trim()) {
      return 'message is required and must be a non-empty string'
    }
    if (body.message.length > MAX_MESSAGE_LENGTH) {
      return `message exceeds maximum length of ${MAX_MESSAGE_LENGTH}`
    }
    if (body.history && (!Array.isArray(body.history) || body.history.length > MAX_HISTORY_MESSAGES)) {
      return `history must be an array of at most ${MAX_HISTORY_MESSAGES} messages`
    }
    return null
  }

  function pickChatFields(body) {
    return {
      message: body.message,
      history: body.history,
      context: body.context,
    }
  }

  /**
   * @openapi
   * /api/modules/chatbot/chat:
   *   post:
   *     tags: [AI Assistant]
   *     summary: Send a chat message (non-streaming)
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             properties:
   *               message:
   *                 type: string
   *               history:
   *                 type: array
   *               context:
   *                 type: string
   *     responses:
   *       200:
   *         description: Chat response
   */
  router.post('/chat', requireAuth, async function(req, res) {
    const validationError = validateChatBody(req.body)
    if (validationError) {
      return res.status(400).json({ error: validationError })
    }

    const serviceUrl = getServiceUrl()
    if (!serviceUrl) {
      return res.status(503).json({ error: 'Chatbot service not configured' })
    }

    try {
      const response = await fetch(`${serviceUrl}/agent/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(pickChatFields(req.body)),
      })

      if (!response.ok) {
        const text = await response.text()
        return res.status(response.status).json({ error: text })
      }

      const data = await response.json()
      res.json(data)
    } catch (err) {
      logger.error('Chatbot proxy error (chat): %s', err.message)
      res.status(502).json({ error: 'Chatbot service unavailable' })
    }
  })

  /**
   * @openapi
   * /api/modules/chatbot/chat/stream:
   *   post:
   *     tags: [AI Assistant]
   *     summary: Send a chat message (SSE streaming)
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             properties:
   *               message:
   *                 type: string
   *               history:
   *                 type: array
   *               context:
   *                 type: string
   *     responses:
   *       200:
   *         description: SSE event stream
   */
  router.post('/chat/stream', requireAuth, async function(req, res) {
    const validationError = validateChatBody(req.body)
    if (validationError) {
      return res.status(400).json({ error: validationError })
    }

    const serviceUrl = getServiceUrl()
    if (!serviceUrl) {
      return res.status(503).json({ error: 'Chatbot service not configured' })
    }

    let reader
    res.on('close', () => {
      if (reader) reader.cancel().catch(() => {})
    })

    try {
      const response = await fetch(`${serviceUrl}/agent/chat/stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(pickChatFields(req.body)),
      })

      if (!response.ok) {
        const text = await response.text()
        return res.status(response.status).json({ error: text })
      }

      res.setHeader('Content-Type', 'text/event-stream')
      res.setHeader('Cache-Control', 'no-cache')
      res.setHeader('Connection', 'keep-alive')
      res.setHeader('X-Accel-Buffering', 'no')
      res.flushHeaders()

      reader = response.body.getReader()
      const decoder = new TextDecoder()

      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          if (!res.writableEnded) res.write(decoder.decode(value, { stream: true }))
        }
      } finally {
        if (!res.writableEnded) res.end()
      }
    } catch (err) {
      logger.error('Chatbot proxy error (stream): %s', err.message)
      if (!res.headersSent) {
        res.status(502).json({ error: 'Chatbot service unavailable' })
      } else if (!res.writableEnded) {
        res.end()
      }
    }
  })

  /**
   * @openapi
   * /api/modules/chatbot/health:
   *   get:
   *     tags: [AI Assistant]
   *     summary: Check chatbot service health
   *     responses:
   *       200:
   *         description: Health status
   */
  router.get('/health', async function(req, res) {
    const serviceUrl = getServiceUrl()
    if (!serviceUrl) {
      return res.json({ status: 'not_configured' })
    }

    try {
      const response = await fetch(`${serviceUrl}/health`, { signal: AbortSignal.timeout(5000) })
      const data = await response.json()
      res.json(data)
    } catch (err) {
      logger.warn('Chatbot health check failed: %s', err.message)
      res.json({ status: 'unreachable' })
    }
  })

  context.registerDiagnostics(async function() {
    const serviceUrl = getServiceUrl()
    if (!serviceUrl) return { status: 'not_configured', message: 'CHATBOT_SERVICE_URL not set' }

    try {
      const response = await fetch(`${serviceUrl}/health`, { signal: AbortSignal.timeout(5000) })
      const data = await response.json()
      return { status: data.status === 'ok' ? 'ok' : 'degraded', checks: data.checks }
    } catch {
      return { status: 'error', message: 'Chatbot service unreachable' }
    }
  })
}
