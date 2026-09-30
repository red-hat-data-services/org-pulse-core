import { describe, it, expect, vi, beforeEach } from 'vitest'
import { trackUsage, trackPageView, _resetUsageTracking } from '../services/usageTracking.js'

const flush = () => new Promise(r => setTimeout(r, 0))
const tracked = () => fetch.mock.calls.filter(c => c[0].endsWith('/track')).map(c => JSON.parse(c[1].body))

describe('usageTracking', () => {
  beforeEach(() => {
    _resetUsageTracking()
    window.location.hash = '#/ai-impact/rfe-review?select=X-1'
    global.fetch = vi.fn(() => Promise.resolve({ json: () => Promise.resolve({ optedOut: false }) }))
  })

  it('posts interactions against the view in the hash, not a stale page', async () => {
    trackPageView('ai-impact::autofix')
    trackUsage('filter', 'status')
    await flush()
    expect(tracked()).toEqual([
      { page: 'ai-impact::autofix' },
      { page: 'ai-impact::rfe-review', action: 'filter', detail: 'status' },
    ])
  })

  it('keeps the finer-grained page the shell recorded', async () => {
    window.location.hash = '#/team-tracker/reports?report=velocity'
    trackPageView('team-tracker::reports/velocity')
    trackPageView('team-tracker::reports/velocity') // deduped
    trackUsage('tab')
    await flush()
    expect(tracked()).toEqual([
      { page: 'team-tracker::reports/velocity' },
      { page: 'team-tracker::reports/velocity', action: 'tab' },
    ])
  })

  it('sends nothing for opted-out users or shell views', async () => {
    window.location.hash = '#/'
    trackUsage('button', 'x')
    expect(fetch).not.toHaveBeenCalled()
    trackUsage('view', '', 'ai-impact::sotu/rfe-actions') // widgets name their own page
    await flush()
    expect(tracked()).toEqual([{ page: 'ai-impact::sotu/rfe-actions', action: 'view' }])

    _resetUsageTracking()
    global.fetch = vi.fn(() => Promise.resolve({ json: () => Promise.resolve({ optedOut: true }) }))
    window.location.hash = '#/ai-impact/autofix'
    trackUsage('button', 'x')
    await flush()
    expect(tracked()).toEqual([])
  })
})
