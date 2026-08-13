import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  registerTeamDetailTab,
  registerReport,
  registerSettingsTab,
  getTeamDetailTabs,
  getReports,
  getSettingsTabs,
  runGuard,
  resetContributions
} from '../../../client/contributions/registry'

const validRender = { type: 'component', load: () => Promise.resolve({}) }

describe('contribution registry', () => {
  beforeEach(() => resetContributions())

  it('registers and returns a team-detail tab', () => {
    registerTeamDetailTab({ id: 'a', label: 'A', render: validRender })
    expect(getTeamDetailTabs().map(t => t.id)).toEqual(['a'])
  })

  it('registers settings tabs and reports independently', () => {
    registerReport({ id: 'r', title: 'R', description: 'd', render: validRender })
    registerSettingsTab({ id: 's', label: 'S', render: validRender })
    expect(getReports().map(r => r.id)).toEqual(['r'])
    expect(getSettingsTabs().map(t => t.id)).toEqual(['s'])
    expect(getTeamDetailTabs()).toHaveLength(0)
  })

  it('sorts contributions by order', () => {
    registerReport({ id: 'b', title: 'B', description: 'd', order: 20, render: validRender })
    registerReport({ id: 'a', title: 'A', description: 'd', order: 10, render: validRender })
    expect(getReports().map(r => r.id)).toEqual(['a', 'b'])
  })

  it('defaults order to 100', () => {
    registerReport({ id: 'x', title: 'X', description: 'd', render: validRender })
    expect(getReports()[0].order).toBe(100)
  })

  it('skips a contribution missing a required field without throwing', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    registerTeamDetailTab({ label: 'no id', render: validRender })
    registerTeamDetailTab({ id: 'ok', label: 'ok', render: validRender })
    expect(getTeamDetailTabs().map(t => t.id)).toEqual(['ok'])
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it('skips a contribution with an invalid render descriptor', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    registerReport({ id: 'bad', title: 'T', description: 'd', render: { type: 'component' } })
    registerReport({ id: 'bad2', title: 'T', description: 'd', render: null })
    expect(getReports()).toHaveLength(0)
    warn.mockRestore()
  })

  it('accepts unknown-but-well-formed render types (forward compatible)', () => {
    registerReport({ id: 'remote', title: 'T', description: 'd', render: { type: 'remote', url: 'x' } })
    expect(getReports().map(r => r.id)).toEqual(['remote'])
  })

  it('skips duplicate ids and keeps the first', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    registerSettingsTab({ id: 'dup', label: 'One', render: validRender })
    registerSettingsTab({ id: 'dup', label: 'Two', render: validRender })
    expect(getSettingsTabs()).toHaveLength(1)
    expect(getSettingsTabs()[0].label).toBe('One')
    warn.mockRestore()
  })

  it('returns defensive copies from getters', () => {
    registerReport({ id: 'a', title: 'A', description: 'd', render: validRender })
    const first = getReports()
    first.push({ id: 'injected' })
    expect(getReports().map(r => r.id)).toEqual(['a'])
  })
})

describe('runGuard', () => {
  it('returns the default when fn is not a function', () => {
    expect(runGuard(undefined, { defaultValue: true })).toBe(true)
    expect(runGuard(undefined, { defaultValue: false })).toBe(false)
  })

  it('coerces truthy / falsy return values to booleans', () => {
    expect(runGuard(() => 1)).toBe(true)
    expect(runGuard(() => 0)).toBe(false)
  })

  it('passes args through to the guard', () => {
    expect(runGuard((a, b) => a + b === 3, { args: [1, 2] })).toBe(true)
  })

  it('returns false when the guard throws', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(runGuard(() => { throw new Error('boom') })).toBe(false)
    expect(err).toHaveBeenCalled()
    err.mockRestore()
  })
})
