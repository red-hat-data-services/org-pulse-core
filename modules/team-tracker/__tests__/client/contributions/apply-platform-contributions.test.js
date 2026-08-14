import { describe, it, expect, vi, beforeEach } from 'vitest'
import { applyPlatformContributions } from '../../../client/contributions/apply-platform-contributions'

function makeApi() {
  return {
    registerTeamDetailTab: vi.fn(),
    registerReport: vi.fn(),
    registerSettingsTab: vi.fn()
  }
}

describe('applyPlatformContributions', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('is a no-op for an empty glob (core / CI, no platform dir)', () => {
    const api = makeApi()
    expect(() => applyPlatformContributions({}, api)).not.toThrow()
    expect(api.registerTeamDetailTab).not.toHaveBeenCalled()
    expect(api.registerReport).not.toHaveBeenCalled()
    expect(api.registerSettingsTab).not.toHaveBeenCalled()
  })

  it('is a no-op when globResult is null or not an object', () => {
    const api = makeApi()
    expect(() => applyPlatformContributions(null, api)).not.toThrow()
    expect(() => applyPlatformContributions(undefined, api)).not.toThrow()
    expect(api.registerTeamDetailTab).not.toHaveBeenCalled()
  })

  it('calls a valid register() export with the injected api', () => {
    const api = makeApi()
    const register = vi.fn((injected) => {
      injected.registerTeamDetailTab({ id: 'x' })
    })
    applyPlatformContributions(
      { '/platform/ext/team-tracker-contributions.js': { register } },
      api
    )
    expect(register).toHaveBeenCalledTimes(1)
    expect(register).toHaveBeenCalledWith(api)
    expect(api.registerTeamDetailTab).toHaveBeenCalledWith({ id: 'x' })
  })

  it('ignores a module without a register export (and warns)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const api = makeApi()
    applyPlatformContributions(
      { '/platform/ext/team-tracker-contributions.js': { notRegister: () => {} } },
      api
    )
    expect(api.registerTeamDetailTab).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalled()
  })

  it('isolates a throwing register() so other extensions still run', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const api = makeApi()
    const good = vi.fn((injected) => injected.registerReport({ id: 'ok' }))
    const bad = vi.fn(() => { throw new Error('boom') })

    applyPlatformContributions(
      {
        '/platform/bad/team-tracker-contributions.js': { register: bad },
        '/platform/good/team-tracker-contributions.js': { register: good }
      },
      api
    )

    expect(bad).toHaveBeenCalledTimes(1)
    expect(good).toHaveBeenCalledTimes(1)
    expect(api.registerReport).toHaveBeenCalledWith({ id: 'ok' })
    expect(error).toHaveBeenCalled()
  })
})
