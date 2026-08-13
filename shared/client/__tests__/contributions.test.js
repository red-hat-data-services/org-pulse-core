import { describe, it, expect, vi } from 'vitest'
import {
  createContributionRegistry,
  runGuard,
  isValidRenderDescriptor,
  resolveRenderDescriptor
} from '../contributions/index.js'

const validRender = { type: 'component', load: () => Promise.resolve({}) }

describe('createContributionRegistry', () => {
  it('requires a non-empty string name', () => {
    expect(() => createContributionRegistry()).toThrow()
    expect(() => createContributionRegistry({ name: '' })).toThrow()
    expect(() => createContributionRegistry({ name: 123 })).toThrow()
  })

  it('registers and returns contributions', () => {
    const reg = createContributionRegistry({ name: 'test:slot' })
    reg.register({ id: 'a', render: validRender })
    expect(reg.getAll().map(c => c.id)).toEqual(['a'])
  })

  it('sorts contributions by order and defaults order to 100', () => {
    const reg = createContributionRegistry({ name: 'test:slot' })
    reg.register({ id: 'b', order: 20, render: validRender })
    reg.register({ id: 'a', order: 10, render: validRender })
    reg.register({ id: 'c', render: validRender })
    expect(reg.getAll().map(c => c.id)).toEqual(['a', 'b', 'c'])
    expect(reg.getAll().find(c => c.id === 'c').order).toBe(100)
  })

  it('skips malformed (non-object) contributions without throwing', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const reg = createContributionRegistry({ name: 'test:slot' })
    reg.register(null)
    reg.register('nope')
    expect(reg.getAll()).toHaveLength(0)
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it('runs the slot-specific validate callback and skips on a string reason', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const reg = createContributionRegistry({
      name: 'test:slot',
      validate: (c) => (c.label ? true : 'missing "label"')
    })
    reg.register({ id: 'no-label', render: validRender })
    reg.register({ id: 'ok', label: 'ok', render: validRender })
    expect(reg.getAll().map(c => c.id)).toEqual(['ok'])
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it('skips when validate returns false or throws', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const reg = createContributionRegistry({
      name: 'test:slot',
      validate: (c) => {
        if (c.id === 'boom') throw new Error('kaboom')
        return c.id !== 'nope'
      }
    })
    reg.register({ id: 'nope', render: validRender })
    reg.register({ id: 'boom', render: validRender })
    reg.register({ id: 'ok', render: validRender })
    expect(reg.getAll().map(c => c.id)).toEqual(['ok'])
    warn.mockRestore()
  })

  it('skips contributions with an invalid render descriptor', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const reg = createContributionRegistry({ name: 'test:slot' })
    reg.register({ id: 'bad', render: { type: 'component' } })
    reg.register({ id: 'bad2', render: null })
    expect(reg.getAll()).toHaveLength(0)
    warn.mockRestore()
  })

  it('accepts unknown-but-well-formed render types (forward compatible)', () => {
    const reg = createContributionRegistry({ name: 'test:slot' })
    reg.register({ id: 'remote', render: { type: 'remote', url: 'x' } })
    expect(reg.getAll().map(c => c.id)).toEqual(['remote'])
  })

  it('skips duplicate ids and keeps the first', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const reg = createContributionRegistry({ name: 'test:slot' })
    reg.register({ id: 'dup', label: 'One', render: validRender })
    reg.register({ id: 'dup', label: 'Two', render: validRender })
    expect(reg.getAll()).toHaveLength(1)
    expect(reg.getAll()[0].label).toBe('One')
    warn.mockRestore()
  })

  it('returns defensive copies from getAll', () => {
    const reg = createContributionRegistry({ name: 'test:slot' })
    reg.register({ id: 'a', render: validRender })
    const first = reg.getAll()
    first.push({ id: 'injected' })
    expect(reg.getAll().map(c => c.id)).toEqual(['a'])
  })

  it('reset clears all registered contributions', () => {
    const reg = createContributionRegistry({ name: 'test:slot' })
    reg.register({ id: 'a', render: validRender })
    reg.reset()
    expect(reg.getAll()).toHaveLength(0)
  })

  it('keeps two independent registries from sharing state', () => {
    const a = createContributionRegistry({ name: 'test:a' })
    const b = createContributionRegistry({ name: 'test:b' })
    a.register({ id: 'only-a', render: validRender })
    b.register({ id: 'only-b', render: validRender })
    expect(a.getAll().map(c => c.id)).toEqual(['only-a'])
    expect(b.getAll().map(c => c.id)).toEqual(['only-b'])
    a.reset()
    expect(a.getAll()).toHaveLength(0)
    expect(b.getAll().map(c => c.id)).toEqual(['only-b'])
  })

  it('exposes runGuard on each registry instance', () => {
    const reg = createContributionRegistry({ name: 'test:slot' })
    expect(reg.runGuard).toBe(runGuard)
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

describe('render descriptor helpers', () => {
  it('isValidRenderDescriptor validates component descriptors and accepts unknown types', () => {
    expect(isValidRenderDescriptor(validRender)).toBe(true)
    expect(isValidRenderDescriptor({ type: 'component' })).toBe(false)
    expect(isValidRenderDescriptor({ type: 'remote', url: 'x' })).toBe(true)
    expect(isValidRenderDescriptor(null)).toBe(false)
    expect(isValidRenderDescriptor({})).toBe(false)
  })

  it('resolveRenderDescriptor centralizes the type switch', () => {
    const resolved = resolveRenderDescriptor(validRender)
    expect(resolved.type).toBe('component')
    expect(typeof resolved.loader).toBe('function')
    expect(resolveRenderDescriptor({ type: 'remote' }).type).toBe('unsupported')
    expect(resolveRenderDescriptor(null).type).toBe('unsupported')
  })
})
