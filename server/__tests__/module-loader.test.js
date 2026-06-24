import { describe, it, expect } from 'vitest'

const {
  loadModuleState,
  saveModuleState,
  getEffectiveState,
  reconcileStartupState,
  resolveEnableOrder,
  checkDisableAllowed,
  computeRequiredBy
} = require('../module-loader')

function makeStorage(data = {}) {
  const store = { ...data }
  return {
    readFromStorage(key) {
      return store[key] !== undefined ? JSON.parse(JSON.stringify(store[key])) : null
    },
    writeToStorage(key, value) {
      store[key] = JSON.parse(JSON.stringify(value))
    },
    _store: store
  }
}

function makeModules(specs) {
  return specs.map(s => ({
    slug: s.slug,
    name: s.name || s.slug,
    requires: s.requires || [],
    defaultEnabled: s.defaultEnabled !== undefined ? s.defaultEnabled : true,
    _dir: `/modules/${s.slug}`,
    server: { entry: './server/index.js' }
  }))
}

describe('loadModuleState', () => {
  it('returns empty object when file does not exist', () => {
    const storage = makeStorage()
    expect(loadModuleState(storage)).toEqual({})
  })

  it('returns persisted state', () => {
    const storage = makeStorage({ 'modules-state.json': { foo: true, bar: false } })
    expect(loadModuleState(storage)).toEqual({ foo: true, bar: false })
  })

  it('returns empty object for invalid data (array)', () => {
    const storage = makeStorage({ 'modules-state.json': [1, 2, 3] })
    expect(loadModuleState(storage)).toEqual({})
  })
})

describe('saveModuleState', () => {
  it('persists state to storage', () => {
    const storage = makeStorage()
    saveModuleState(storage, { foo: true })
    expect(storage._store['modules-state.json']).toEqual({ foo: true })
  })
})

describe('getEffectiveState', () => {
  it('uses persisted state when available', () => {
    const modules = makeModules([
      { slug: 'a', defaultEnabled: true },
      { slug: 'b', defaultEnabled: true }
    ])
    const persisted = { a: false }
    const result = getEffectiveState(modules, persisted)
    expect(result).toEqual({ a: false, b: true })
  })

  it('falls back to defaultEnabled', () => {
    const modules = makeModules([
      { slug: 'a', defaultEnabled: false },
      { slug: 'b', defaultEnabled: true }
    ])
    const result = getEffectiveState(modules, {})
    expect(result).toEqual({ a: false, b: true })
  })
})

describe('reconcileStartupState', () => {
  it('auto-enables required modules', () => {
    const modules = makeModules([
      { slug: 'a', requires: ['b'] },
      { slug: 'b' }
    ])
    const effective = { a: true, b: false }
    const storage = makeStorage()
    reconcileStartupState(modules, effective, storage)
    expect(effective.b).toBe(true)
    expect(storage._store['modules-state.json']).toEqual({ a: true, b: true })
  })

  it('does nothing when all deps satisfied', () => {
    const modules = makeModules([
      { slug: 'a', requires: ['b'] },
      { slug: 'b' }
    ])
    const effective = { a: true, b: true }
    const storage = makeStorage()
    reconcileStartupState(modules, effective, storage)
    expect(storage._store['modules-state.json']).toBeUndefined()
  })
})

describe('resolveEnableOrder', () => {
  it('returns just the target when no deps', () => {
    const modules = makeModules([{ slug: 'a' }])
    const state = { a: false }
    const result = resolveEnableOrder('a', modules, state)
    expect(result.toEnable).toEqual(['a'])
    expect(result.autoEnabled).toEqual([])
  })

  it('includes disabled transitive deps', () => {
    const modules = makeModules([
      { slug: 'a', requires: ['b'] },
      { slug: 'b', requires: ['c'] },
      { slug: 'c' }
    ])
    const state = { a: false, b: false, c: false }
    const result = resolveEnableOrder('a', modules, state)
    expect(result.toEnable).toContain('a')
    expect(result.toEnable).toContain('b')
    expect(result.toEnable).toContain('c')
    expect(result.autoEnabled).toContain('b')
    expect(result.autoEnabled).toContain('c')
    expect(result.autoEnabled).not.toContain('a')
  })

  it('skips already-enabled deps', () => {
    const modules = makeModules([
      { slug: 'a', requires: ['b'] },
      { slug: 'b' }
    ])
    const state = { a: false, b: true }
    const result = resolveEnableOrder('a', modules, state)
    expect(result.toEnable).toEqual(['a'])
    expect(result.autoEnabled).toEqual([])
  })

  it('returns error for non-existent dep', () => {
    const modules = makeModules([
      { slug: 'a', requires: ['missing'] }
    ])
    const state = { a: false }
    const result = resolveEnableOrder('a', modules, state)
    expect(result.error).toContain('non-existent')
  })
})

describe('checkDisableAllowed', () => {
  it('allows disabling when no dependents', () => {
    const modules = makeModules([{ slug: 'a' }, { slug: 'b' }])
    const state = { a: true, b: true }
    expect(checkDisableAllowed('a', modules, state)).toEqual({ allowed: true })
  })

  it('blocks disabling when depended on by enabled module', () => {
    const modules = makeModules([
      { slug: 'a', requires: ['b'] },
      { slug: 'b' }
    ])
    const state = { a: true, b: true }
    const result = checkDisableAllowed('b', modules, state)
    expect(result.allowed).toBe(false)
    expect(result.blockedBy).toContain('a')
  })

  it('allows disabling when dependent is also disabled', () => {
    const modules = makeModules([
      { slug: 'a', requires: ['b'] },
      { slug: 'b' }
    ])
    const state = { a: false, b: true }
    expect(checkDisableAllowed('b', modules, state)).toEqual({ allowed: true })
  })

  it('detects transitive dependency blocking', () => {
    const modules = makeModules([
      { slug: 'a', requires: ['b'] },
      { slug: 'b', requires: ['c'] },
      { slug: 'c' }
    ])
    const state = { a: true, b: true, c: true }
    const result = checkDisableAllowed('c', modules, state)
    expect(result.allowed).toBe(false)
    expect(result.blockedBy).toContain('a')
    expect(result.blockedBy).toContain('b')
  })
})

describe('computeRequiredBy', () => {
  it('builds reverse dependency map', () => {
    const modules = makeModules([
      { slug: 'a', requires: ['b', 'c'] },
      { slug: 'b', requires: ['c'] },
      { slug: 'c' }
    ])
    const result = computeRequiredBy(modules)
    expect(result.c).toContain('a')
    expect(result.c).toContain('b')
    expect(result.b).toContain('a')
    expect(result.a).toEqual([])
  })
})
