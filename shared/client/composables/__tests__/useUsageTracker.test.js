import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

let useUsageTracker

describe('useUsageTracker', () => {
  let tracker

  beforeEach(async () => {
    vi.useFakeTimers()
    global.fetch = vi.fn(() => Promise.resolve({ ok: true }))
    vi.resetModules()
    const mod = await import('../useUsageTracker.js')
    useUsageTracker = mod.useUsageTracker
    tracker = useUsageTracker()
  })

  afterEach(() => {
    tracker.stop()
    vi.useRealTimers()
    delete global.fetch
  })

  it('returns expected API', () => {
    expect(tracker.trackView).toBeTypeOf('function')
    expect(tracker.trackInteraction).toBeTypeOf('function')
    expect(tracker.start).toBeTypeOf('function')
    expect(tracker.stop).toBeTypeOf('function')
    expect(tracker.flush).toBeTypeOf('function')
    expect(tracker.disable).toBeTypeOf('function')
  })

  it('does not track before start', async () => {
    tracker.trackView('ai-impact', 'autofix')
    await tracker.flush()
    expect(global.fetch).not.toHaveBeenCalled()
  })

  it('buffers events after start', () => {
    tracker.start()
    tracker.trackView('ai-impact', 'autofix')
    tracker.trackInteraction('ai-impact', 'autofix', 'filter', 'timeWindow')
    expect(global.fetch).not.toHaveBeenCalled()
  })

  it('flushes on explicit flush after start', async () => {
    tracker.start()
    tracker.trackView('ai-impact', 'autofix')
    await tracker.flush()

    expect(global.fetch).toHaveBeenCalledTimes(1)
    const call = global.fetch.mock.calls[0]
    expect(call[0]).toBe('/api/usage/events')
    expect(call[1].method).toBe('POST')
    const body = JSON.parse(call[1].body)
    expect(body.events).toHaveLength(1)
    expect(body.events[0].module).toBe('ai-impact')
  })

  it('flushes when batch reaches 50 events', async () => {
    tracker.start()
    for (let i = 0; i < 50; i++) {
      tracker.trackView('ai-impact', `view-${i}`)
    }
    await Promise.resolve()
    expect(global.fetch).toHaveBeenCalled()
  })

  it('does not track when disabled', async () => {
    tracker.start()
    tracker.disable()
    tracker.trackView('ai-impact', 'autofix')
    await tracker.flush()
    expect(global.fetch).not.toHaveBeenCalled()
  })

  it('includes org in tracked events', async () => {
    tracker.start()
    tracker.trackView('ai-impact', 'autofix', 'rhai')
    await tracker.flush()

    expect(global.fetch).toHaveBeenCalledTimes(1)
    const call = global.fetch.mock.calls[0]
    const body = JSON.parse(call[1].body)
    expect(body.events[0].org).toBe('rhai')
  })

  it('sends correct event structure', async () => {
    tracker.start()
    tracker.trackInteraction('ai-impact', 'autofix', 'filter', 'component-picker', 'rhai')
    await tracker.flush()

    expect(global.fetch).toHaveBeenCalledTimes(1)
    const call = global.fetch.mock.calls[0]
    const body = JSON.parse(call[1].body)
    expect(body.events[0]).toMatchObject({
      module: 'ai-impact',
      view: 'autofix',
      action: 'filter',
      target: 'component-picker',
      org: 'rhai'
    })
    expect(body.events[0].clientTs).toBeTypeOf('number')
  })

  it('retains batch on non-ok response', async () => {
    global.fetch = vi.fn(() => Promise.resolve({ ok: false, status: 500 }))
    tracker.start()
    tracker.trackView('ai-impact', 'autofix')
    await tracker.flush()

    global.fetch = vi.fn(() => Promise.resolve({ ok: true }))
    await tracker.flush()
    expect(global.fetch).toHaveBeenCalledTimes(1)
    const body = JSON.parse(global.fetch.mock.calls[0][1].body)
    expect(body.events).toHaveLength(1)
  })

  it('drops events beyond buffer cap', () => {
    tracker.start()
    for (let i = 0; i < 510; i++) {
      tracker.trackView('mod', `v-${i}`)
    }
    global.fetch = vi.fn(() => Promise.resolve({ ok: true }))
    tracker.flush()
    const body = JSON.parse(global.fetch.mock.calls[0][1].body)
    expect(body.events.length).toBeLessThanOrEqual(500)
  })

  it('removes visibilitychange listener on stop', () => {
    const removeSpy = vi.spyOn(document, 'removeEventListener')
    tracker.start()
    tracker.stop()
    expect(removeSpy).toHaveBeenCalledWith('visibilitychange', expect.any(Function))
    removeSpy.mockRestore()
  })
})
