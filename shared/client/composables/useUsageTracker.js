const FLUSH_INTERVAL_MS = 30_000
const MAX_BATCH_SIZE = 50
const MAX_BUFFER_SIZE = 500
const RETRY_BASE_DELAY_MS = 30_000
const RETRY_MAX_DELAY_MS = 15 * 60_000

const buffer = []
let flushTimer = null
let started = false
let disabled = false
let flushing = false
let retryDelayMs = 0
let retryAfter = 0
let visibilityHandler = null

function flushForNavigation() {
  flush({ keepalive: true })
}

function track(module, view, action, target = null, org = null) {
  if (disabled || !started) return
  if (buffer.length >= MAX_BUFFER_SIZE) return
  buffer.push({ module, view, action, target, org, clientTs: Date.now() })
  if (buffer.length >= MAX_BATCH_SIZE) flush()
}

function trackView(module, viewId, org = null) {
  track(module, viewId, 'view', null, org)
}

function trackInteraction(module, viewId, action, target = null, org = null) {
  track(module, viewId, action, target, org)
}

async function flush({ keepalive = false } = {}) {
  if (disabled || flushing || buffer.length === 0) return
  if (!keepalive && Date.now() < retryAfter) return

  flushing = true
  const batch = buffer.splice(0)
  const body = JSON.stringify({ events: batch })

  try {
    if (keepalive && typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function') {
      try {
        const queued = navigator.sendBeacon(
          '/api/usage/events',
          new Blob([body], { type: 'application/json' })
        )
        if (queued) {
          resetRetryDelay()
          return
        }
      } catch {
        // Fall back to a keepalive fetch when beacon queuing is unavailable.
      }
    }

    const res = await fetch('/api/usage/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      keepalive
    })
    if (!res.ok) {
      if (res.status === 404) {
        disable()
        return
      }
      requeueBatch(batch)
      scheduleRetry()
      return
    }
    resetRetryDelay()
  } catch {
    requeueBatch(batch)
    scheduleRetry()
  } finally {
    flushing = false
  }
}

function requeueBatch(batch) {
  if (!disabled && buffer.length + batch.length <= MAX_BUFFER_SIZE) {
    buffer.unshift(...batch)
  }
}

function scheduleRetry() {
  if (disabled) return
  retryDelayMs = retryDelayMs === 0
    ? RETRY_BASE_DELAY_MS
    : Math.min(retryDelayMs * 2, RETRY_MAX_DELAY_MS)
  retryAfter = Date.now() + retryDelayMs
}

function resetRetryDelay() {
  retryDelayMs = 0
  retryAfter = 0
}

function start() {
  if (started || disabled) return
  started = true
  flushTimer = setInterval(flush, FLUSH_INTERVAL_MS)
  if (typeof window !== 'undefined') {
    window.addEventListener('beforeunload', flushForNavigation)
    visibilityHandler = function () {
      if (document.visibilityState === 'hidden') flushForNavigation()
    }
    document.addEventListener('visibilitychange', visibilityHandler)
  }
}

function stop() {
  if (!started) return
  started = false
  clearInterval(flushTimer)
  flushTimer = null
  if (typeof window !== 'undefined') {
    window.removeEventListener('beforeunload', flushForNavigation)
    if (visibilityHandler) {
      document.removeEventListener('visibilitychange', visibilityHandler)
      visibilityHandler = null
    }
  }
  return flush({ keepalive: true })
}

function disable() {
  // A privacy opt-out or unavailable endpoint disables tracking for this page lifetime.
  disabled = true
  buffer.length = 0
  resetRetryDelay()
  stop()
}

export function useUsageTracker() {
  return { trackView, trackInteraction, start, stop, flush, disable }
}
