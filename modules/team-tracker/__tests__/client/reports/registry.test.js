import { describe, it, expect, vi, beforeEach } from 'vitest'

// These tests verify that core reports register into the shared contribution
// registry, and that allocation registers (only) when a strategy is configured.
// The Reports hub reads the merged set via getReports().

describe('Report registrations (strategy configured)', () => {
  let getReports

  beforeEach(async () => {
    vi.resetModules()
    vi.doMock('@/platform-loader', () => ({
      loadAllocationStrategy: () => ({
        id: 'ai-eng-40-40-20',
        name: '40/40/20 Allocation',
        description: 'AI Engineering allocation strategy',
        categories: []
      })
    }))
    ;({ getReports } = await import('../../../client/contributions'))
  })

  it('registers the core reports', () => {
    const ids = getReports().map(r => r.id)
    expect(ids).toContain('trends')
    expect(ids).toContain('team-comparison')
  })

  it('registers the allocation report when a strategy is configured', () => {
    const ids = getReports().map(r => r.id)
    expect(ids).toContain('allocation')
  })

  it('all reports expose required fields and a component render descriptor', () => {
    for (const report of getReports()) {
      expect(typeof report.id).toBe('string')
      expect(typeof report.title).toBe('string')
      expect(typeof report.description).toBe('string')
      expect(report.render).toBeTruthy()
      expect(report.render.type).toBe('component')
      expect(typeof report.render.load).toBe('function')
    }
  })

  it('all report IDs are unique', () => {
    const ids = getReports().map(r => r.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('trends report uses org and team filters', () => {
    const trends = getReports().find(r => r.id === 'trends')
    expect(trends.filters).toEqual(['org', 'team'])
  })

  it('allocation report uses no shared filters, is available, and names the strategy', () => {
    const allocation = getReports().find(r => r.id === 'allocation')
    expect(allocation.filters).toEqual([])
    expect(allocation.description).toContain('40/40/20 Allocation')
    expect(allocation.isAvailable()).toBe(true)
  })
})

describe('Report registrations (no strategy)', () => {
  it('excludes the allocation report when no strategy is configured', async () => {
    vi.resetModules()
    vi.doMock('@/platform-loader', () => ({
      loadAllocationStrategy: () => null
    }))
    const { getReports } = await import('../../../client/contributions')
    const ids = getReports().map(r => r.id)
    expect(ids).toContain('trends')
    expect(ids).toContain('team-comparison')
    expect(ids).not.toContain('allocation')
  })
})
