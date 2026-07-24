import { describe, it, expect, vi } from 'vitest'

const { createSearchIndexRegistry } = require('../search-index-registry')

function makeStorage(data = {}) {
  return {
    readFromStorage(path) {
      if (path in data) return data[path]
      return null
    }
  }
}

describe('search-index-registry', () => {
  describe('getNestedValue (via processDeclaration)', () => {
    it('resolves nested items path', async () => {
      const registry = createSearchIndexRegistry()
      const storage = makeStorage({
        'features.json': { deep: { list: [{ name: 'A' }] } }
      })
      registry.registerDeclarative('mod', [{
        source: 'features.json',
        items: 'deep.list',
        label: 'name',
        viewId: 'v1',
        context: 'Ctx'
      }])
      const results = await registry.collect(storage)
      expect(results).toEqual([{
        label: 'A', context: 'Ctx', viewId: 'v1',
        params: undefined, keywords: [], module: 'mod'
      }])
    })

    it('returns null for null intermediate in path', async () => {
      const registry = createSearchIndexRegistry()
      const storage = makeStorage({ 'f.json': { a: null } })
      registry.registerDeclarative('mod', [{
        source: 'f.json', items: 'a.b.c', label: 'name', viewId: 'v'
      }])
      const results = await registry.collect(storage)
      expect(results).toEqual([])
    })
  })

  describe('matchesFilter (via processDeclaration)', () => {
    it('includes items when no filter is set', async () => {
      const registry = createSearchIndexRegistry()
      const storage = makeStorage({
        'items.json': [{ name: 'X', status: 'open' }]
      })
      registry.registerDeclarative('mod', [{
        source: 'items.json', label: 'name', viewId: 'v'
      }])
      const results = await registry.collect(storage)
      expect(results.length).toBe(1)
    })

    it('filters items by single key match', async () => {
      const registry = createSearchIndexRegistry()
      const storage = makeStorage({
        'items.json': [
          { name: 'A', status: 'open' },
          { name: 'B', status: 'closed' }
        ]
      })
      registry.registerDeclarative('mod', [{
        source: 'items.json', label: 'name', viewId: 'v',
        filter: { status: 'open' }
      }])
      const results = await registry.collect(storage)
      expect(results.length).toBe(1)
      expect(results[0].label).toBe('A')
    })

    it('requires all filter keys to match', async () => {
      const registry = createSearchIndexRegistry()
      const storage = makeStorage({
        'items.json': [
          { name: 'A', status: 'open', priority: 'high' },
          { name: 'B', status: 'open', priority: 'low' }
        ]
      })
      registry.registerDeclarative('mod', [{
        source: 'items.json', label: 'name', viewId: 'v',
        filter: { status: 'open', priority: 'high' }
      }])
      const results = await registry.collect(storage)
      expect(results.length).toBe(1)
      expect(results[0].label).toBe('A')
    })
  })

  describe('resolveParams (via processDeclaration)', () => {
    it('resolves $field references from item', async () => {
      const registry = createSearchIndexRegistry()
      const storage = makeStorage({
        'items.json': [{ name: 'Feature X', key: 'FX-1' }]
      })
      registry.registerDeclarative('mod', [{
        source: 'items.json', label: 'name', viewId: 'v',
        params: { feature: '$key' }
      }])
      const results = await registry.collect(storage)
      expect(results[0].params).toEqual({ feature: 'FX-1' })
    })

    it('passes through literal values', async () => {
      const registry = createSearchIndexRegistry()
      const storage = makeStorage({
        'items.json': [{ name: 'X' }]
      })
      registry.registerDeclarative('mod', [{
        source: 'items.json', label: 'name', viewId: 'v',
        params: { mode: 'detail' }
      }])
      const results = await registry.collect(storage)
      expect(results[0].params).toEqual({ mode: 'detail' })
    })

    it('returns undefined when no params template', async () => {
      const registry = createSearchIndexRegistry()
      const storage = makeStorage({
        'items.json': [{ name: 'X' }]
      })
      registry.registerDeclarative('mod', [{
        source: 'items.json', label: 'name', viewId: 'v'
      }])
      const results = await registry.collect(storage)
      expect(results[0].params).toBeUndefined()
    })
  })

  describe('resolveKeywords (via processDeclaration)', () => {
    it('extracts field values as string array', async () => {
      const registry = createSearchIndexRegistry()
      const storage = makeStorage({
        'items.json': [{ name: 'X', status: 'open', tag: 'urgent' }]
      })
      registry.registerDeclarative('mod', [{
        source: 'items.json', label: 'name', viewId: 'v',
        keywords: ['status', 'tag']
      }])
      const results = await registry.collect(storage)
      expect(results[0].keywords).toEqual(['open', 'urgent'])
    })

    it('skips missing fields', async () => {
      const registry = createSearchIndexRegistry()
      const storage = makeStorage({
        'items.json': [{ name: 'X', status: 'open' }]
      })
      registry.registerDeclarative('mod', [{
        source: 'items.json', label: 'name', viewId: 'v',
        keywords: ['status', 'nonexistent']
      }])
      const results = await registry.collect(storage)
      expect(results[0].keywords).toEqual(['open'])
    })

    it('converts non-string values via String()', async () => {
      const registry = createSearchIndexRegistry()
      const storage = makeStorage({
        'items.json': [{ name: 'X', count: 42 }]
      })
      registry.registerDeclarative('mod', [{
        source: 'items.json', label: 'name', viewId: 'v',
        keywords: ['count']
      }])
      const results = await registry.collect(storage)
      expect(results[0].keywords).toEqual(['42'])
    })

    it('returns empty array when keywords not specified', async () => {
      const registry = createSearchIndexRegistry()
      const storage = makeStorage({
        'items.json': [{ name: 'X' }]
      })
      registry.registerDeclarative('mod', [{
        source: 'items.json', label: 'name', viewId: 'v'
      }])
      const results = await registry.collect(storage)
      expect(results[0].keywords).toEqual([])
    })
  })

  describe('processDeclaration', () => {
    it('handles array source data', async () => {
      const registry = createSearchIndexRegistry()
      const storage = makeStorage({
        'list.json': [{ title: 'A' }, { title: 'B' }]
      })
      registry.registerDeclarative('mod', [{
        source: 'list.json', label: 'title', viewId: 'v'
      }])
      const results = await registry.collect(storage)
      expect(results.length).toBe(2)
    })

    it('handles object source data with $key injection', async () => {
      const registry = createSearchIndexRegistry()
      const storage = makeStorage({
        'map.json': { 'KEY-1': { title: 'First' }, 'KEY-2': { title: 'Second' } }
      })
      registry.registerDeclarative('mod', [{
        source: 'map.json', label: 'title', viewId: 'v',
        params: { key: '$$$key' }
      }])
      const results = await registry.collect(storage)
      expect(results.length).toBe(2)
    })

    it('uses fallbackLabel when label field is missing', async () => {
      const registry = createSearchIndexRegistry()
      const storage = makeStorage({
        'items.json': [{ summary: 'Fallback Title' }]
      })
      registry.registerDeclarative('mod', [{
        source: 'items.json', label: 'name', fallbackLabel: 'summary', viewId: 'v'
      }])
      const results = await registry.collect(storage)
      expect(results[0].label).toBe('Fallback Title')
    })

    it('skips items with no label and no fallbackLabel', async () => {
      const registry = createSearchIndexRegistry()
      const storage = makeStorage({
        'items.json': [{ id: 1 }, { name: 'Has Name' }]
      })
      registry.registerDeclarative('mod', [{
        source: 'items.json', label: 'name', viewId: 'v'
      }])
      const results = await registry.collect(storage)
      expect(results.length).toBe(1)
      expect(results[0].label).toBe('Has Name')
    })

    it('uses context from declaration or defaults to slug', async () => {
      const registry = createSearchIndexRegistry()
      const storage = makeStorage({
        'a.json': [{ name: 'X' }],
        'b.json': [{ name: 'Y' }]
      })
      registry.registerDeclarative('my-mod', [
        { source: 'a.json', label: 'name', viewId: 'v', context: 'Custom Context' },
        { source: 'b.json', label: 'name', viewId: 'v' }
      ])
      const results = await registry.collect(storage)
      expect(results[0].context).toBe('Custom Context')
      expect(results[1].context).toBe('my-mod')
    })

    it('returns empty when storage returns null', async () => {
      const registry = createSearchIndexRegistry()
      const storage = makeStorage({})
      registry.registerDeclarative('mod', [{
        source: 'missing.json', label: 'name', viewId: 'v'
      }])
      const results = await registry.collect(storage)
      expect(results).toEqual([])
    })

    it('catches storage errors and returns empty', async () => {
      const registry = createSearchIndexRegistry()
      const storage = {
        readFromStorage() { throw new Error('disk failure') }
      }
      const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
      registry.registerDeclarative('mod', [{
        source: 'broken.json', label: 'name', viewId: 'v'
      }])
      const results = await registry.collect(storage)
      expect(results).toEqual([])
      expect(spy).toHaveBeenCalled()
      spy.mockRestore()
    })

    it('returns empty for non-array non-object raw data', async () => {
      const registry = createSearchIndexRegistry()
      const storage = makeStorage({ 'scalar.json': 'just a string' })
      registry.registerDeclarative('mod', [{
        source: 'scalar.json', label: 'name', viewId: 'v'
      }])
      const results = await registry.collect(storage)
      expect(results).toEqual([])
    })
  })

  describe('register (custom handler)', () => {
    it('registers a function handler', async () => {
      const registry = createSearchIndexRegistry()
      const handler = vi.fn().mockResolvedValue([{ label: 'Custom', viewId: 'v' }])
      registry.register('mod', handler)
      const results = await registry.collect(makeStorage())
      expect(results.length).toBe(1)
      expect(results[0].label).toBe('Custom')
      expect(results[0].module).toBe('mod')
    })

    it('warns and skips non-function handler', () => {
      const registry = createSearchIndexRegistry()
      const spy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      registry.register('mod', 'not a function')
      spy.mockRestore()
    })

    it('catches handler errors and continues', async () => {
      const registry = createSearchIndexRegistry()
      const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
      registry.register('broken', () => { throw new Error('boom') })
      registry.register('good', async () => [{ label: 'OK', viewId: 'v' }])
      const results = await registry.collect(makeStorage())
      expect(results.length).toBe(1)
      expect(results[0].label).toBe('OK')
      expect(spy).toHaveBeenCalled()
      spy.mockRestore()
    })

    it('ignores handler returning non-array', async () => {
      const registry = createSearchIndexRegistry()
      registry.register('mod', async () => 'not an array')
      const results = await registry.collect(makeStorage())
      expect(results).toEqual([])
    })
  })

  describe('registerDeclarative', () => {
    it('skips non-array entries', async () => {
      const registry = createSearchIndexRegistry()
      registry.registerDeclarative('mod', 'not an array')
      const results = await registry.collect(makeStorage())
      expect(results).toEqual([])
    })

    it('skips empty array entries', async () => {
      const registry = createSearchIndexRegistry()
      registry.registerDeclarative('mod', [])
      const results = await registry.collect(makeStorage())
      expect(results).toEqual([])
    })
  })

  describe('collect', () => {
    it('combines declarative and handler results', async () => {
      const registry = createSearchIndexRegistry()
      const storage = makeStorage({
        'items.json': [{ name: 'Declarative' }]
      })
      registry.registerDeclarative('decl-mod', [{
        source: 'items.json', label: 'name', viewId: 'v'
      }])
      registry.register('handler-mod', async () => [{ label: 'Handler', viewId: 'v2' }])
      const results = await registry.collect(storage)
      expect(results.length).toBe(2)
      expect(results[0].module).toBe('decl-mod')
      expect(results[1].module).toBe('handler-mod')
    })

    it('returns empty array when nothing is registered', async () => {
      const registry = createSearchIndexRegistry()
      const results = await registry.collect(makeStorage())
      expect(results).toEqual([])
    })

    it('adds module field to handler results', async () => {
      const registry = createSearchIndexRegistry()
      registry.register('my-slug', async () => [{ label: 'X', viewId: 'v' }])
      const results = await registry.collect(makeStorage())
      expect(results[0].module).toBe('my-slug')
    })
  })
})
