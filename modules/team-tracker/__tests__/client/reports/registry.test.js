import { describe, it, expect, beforeEach, vi } from 'vitest'

// These tests verify that the core reports register into the shared contribution
// registry. The Reports hub reads the merged set via getReports(). Feature
// reports are provided by platform contributions (absent in core / CI).

describe('Core report registrations', () => {
  let getReports

  beforeEach(async () => {
    vi.resetModules()
    ;({ getReports } = await import('../../../client/contributions'))
  })

  it('registers the core reports', () => {
    const ids = getReports().map(r => r.id)
    expect(ids).toContain('trends')
    expect(ids).toContain('team-comparison')
  })

  it('registers only the core reports in core (no platform contributions)', () => {
    const ids = getReports().map(r => r.id)
    expect(ids).toEqual(['trends', 'team-comparison'])
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
})
