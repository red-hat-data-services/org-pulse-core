import { ref } from 'vue'

const FLUSH_INTERVAL_MS = 30_000
const MAX_BATCH_SIZE = 50
const MAX_BUFFER_SIZE = 500

const buffer = ref([])
let flushTimer = null
let started = false
let disabled = false
let visibilityHandler = null

function track(module, view, action, target = null, org = null) {
  if (disabled || !started) return
  if (buffer.value.length >= MAX_BUFFER_SIZE) return
  buffer.value.push({ module, view, action, target, org, clientTs: Date.now() })
  if (buffer.value.length >= MAX_BATCH_SIZE) flush()
}

function trackView(module, viewId, org = null) {
  track(module, viewId, 'view', null, org)
}

function trackInteraction(module, viewId, action, target = null, org = null) {
  track(module, viewId, action, target, org)
}

async function flush() {
  if (buffer.value.length === 0) return
  const batch = buffer.value.splice(0)
  try {
    const res = await fetch('/api/usage/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ events: batch })
    })
    if (!res.ok && buffer.value.length + batch.length <= MAX_BUFFER_SIZE) {
      buffer.value.unshift(...batch)
    }
  } catch {
    if (buffer.value.length + batch.length <= MAX_BUFFER_SIZE) {
      buffer.value.unshift(...batch)
    }
  }
}

function start() {
  if (started) return
  started = true
  flushTimer = setInterval(flush, FLUSH_INTERVAL_MS)
  if (typeof window !== 'undefined') {
    window.addEventListener('beforeunload', flush)
    visibilityHandler = function () {
      if (document.visibilityState === 'hidden') flush()
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
    window.removeEventListener('beforeunload', flush)
    if (visibilityHandler) {
      document.removeEventListener('visibilitychange', visibilityHandler)
      visibilityHandler = null
    }
  }
  flush()
}

function disable() {
  disabled = true
}

export function useUsageTracker() {
  return { trackView, trackInteraction, start, stop, flush, disable }
}
