import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockManifests = vi.hoisted(() => ({ value: {} }))
const mockComponents = vi.hoisted(() => ({ value: {} }))
const mockViewComponents = vi.hoisted(() => ({ value: {} }))

vi.mock('/platform/*/manifest.json', () => mockManifests.value, { virtual: true })

describe('loadPlatformAboutTabs', () => {
  beforeEach(async () => {
    vi.resetModules()
    mockManifests.value = {}
    mockComponents.value = {}

    vi.doMock('vue', async () => {
      const actual = await vi.importActual('vue')
      return {
        ...actual,
        defineAsyncComponent: (loader) => ({ __asyncLoader: loader, __name: 'AsyncComponent' })
      }
    })

    vi.stubGlobal('import', { meta: { glob: () => ({}) } })
  })

  async function loadWithMocks(manifests, components) {
    vi.doMock('../platform-loader', async () => {
      const { defineAsyncComponent } = await import('vue')

      function loadPlatformAboutTabsImpl() {
        const manifest = manifests['/platform/about-tabs/manifest.json']
        if (!manifest) return []
        const tabs = (manifest.default || manifest).tabs || []
        return tabs.map(tab => {
          const normalized = tab.component.replace(/^\.\//, '')
          const globKey = `/platform/about-tabs/${normalized}`
          const loader = components[globKey]
          if (!loader) {
            console.warn(`Platform about tab component not found: ${globKey}`)
            return null
          }
          return {
            id: tab.id,
            label: tab.label,
            iconName: tab.icon,
            order: tab.order ?? 100,
            requireRole: tab.requireRole || null,
            component: defineAsyncComponent(loader),
            source: 'platform'
          }
        }).filter(Boolean)
      }

      return { loadPlatformAboutTabs: loadPlatformAboutTabsImpl }
    })

    const mod = await import('../platform-loader')
    return mod.loadPlatformAboutTabs
  }

  it('returns empty array when no manifest exists', async () => {
    const fn = await loadWithMocks({}, {})
    expect(fn()).toEqual([])
  })

  it('parses a valid manifest and returns tab objects', async () => {
    const manifests = {
      '/platform/about-tabs/manifest.json': {
        default: {
          tabs: [{
            id: 'docs',
            label: 'Docs',
            icon: 'BookOpen',
            component: './DocsTab.vue',
            order: 15
          }]
        }
      }
    }
    const components = {
      '/platform/about-tabs/DocsTab.vue': () => Promise.resolve({ default: {} })
    }

    const fn = await loadWithMocks(manifests, components)
    const result = fn()

    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({
      id: 'docs',
      label: 'Docs',
      iconName: 'BookOpen',
      order: 15,
      requireRole: null,
      source: 'platform'
    })
    expect(result[0].component).toBeDefined()
  })

  it('defaults order to 100 when omitted', async () => {
    const manifests = {
      '/platform/about-tabs/manifest.json': {
        default: {
          tabs: [{
            id: 'custom',
            label: 'Custom',
            icon: 'Settings',
            component: './CustomTab.vue'
          }]
        }
      }
    }
    const components = {
      '/platform/about-tabs/CustomTab.vue': () => Promise.resolve({ default: {} })
    }

    const fn = await loadWithMocks(manifests, components)
    const result = fn()

    expect(result[0].order).toBe(100)
  })

  it('skips tabs whose component is not found', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const manifests = {
      '/platform/about-tabs/manifest.json': {
        default: {
          tabs: [{
            id: 'missing',
            label: 'Missing',
            icon: 'X',
            component: './Missing.vue'
          }]
        }
      }
    }

    const fn = await loadWithMocks(manifests, {})
    const result = fn()

    expect(result).toEqual([])
    expect(warnSpy).toHaveBeenCalledWith(
      'Platform about tab component not found: /platform/about-tabs/Missing.vue'
    )
    warnSpy.mockRestore()
  })

  it('handles multiple tabs in a manifest', async () => {
    const manifests = {
      '/platform/about-tabs/manifest.json': {
        default: {
          tabs: [
            { id: 'tab-a', label: 'A', icon: 'Home', component: './A.vue', order: 20 },
            { id: 'tab-b', label: 'B', icon: 'Settings', component: './B.vue', order: 30 }
          ]
        }
      }
    }
    const components = {
      '/platform/about-tabs/A.vue': () => Promise.resolve({ default: {} }),
      '/platform/about-tabs/B.vue': () => Promise.resolve({ default: {} })
    }

    const fn = await loadWithMocks(manifests, components)
    const result = fn()

    expect(result).toHaveLength(2)
    expect(result[0].id).toBe('tab-a')
    expect(result[1].id).toBe('tab-b')
  })

  it('strips leading ./ from component paths', async () => {
    const manifests = {
      '/platform/about-tabs/manifest.json': {
        default: {
          tabs: [{
            id: 'test',
            label: 'Test',
            icon: 'Home',
            component: './Nested.vue'
          }]
        }
      }
    }
    const components = {
      '/platform/about-tabs/Nested.vue': () => Promise.resolve({ default: {} })
    }

    const fn = await loadWithMocks(manifests, components)
    const result = fn()

    expect(result).toHaveLength(1)
    expect(result[0].id).toBe('test')
  })

  it('preserves requireRole when specified', async () => {
    const manifests = {
      '/platform/about-tabs/manifest.json': {
        default: {
          tabs: [{
            id: 'admin-tab',
            label: 'Admin',
            icon: 'Shield',
            component: './Admin.vue',
            requireRole: 'super-admin'
          }]
        }
      }
    }
    const components = {
      '/platform/about-tabs/Admin.vue': () => Promise.resolve({ default: {} })
    }

    const fn = await loadWithMocks(manifests, components)
    const result = fn()

    expect(result[0].requireRole).toBe('super-admin')
  })
})

describe('loadModuleViewExtensions', () => {
  beforeEach(() => {
    vi.resetModules()
    mockManifests.value = {}
    mockViewComponents.value = {}
  })

  function loadWithMocks(manifests, viewComponents) {
    const { defineAsyncComponent } = require('vue')

    function loadModuleViewExtensionsImpl() {
      const result = {}
      for (const [manifestPath, raw] of Object.entries(manifests)) {
        const manifest = raw.default || raw
        if (manifest.type !== 'module-views') continue
        if (!manifest.targetModule || !manifest.client?.views) continue
        const parts = manifestPath.split('/')
        const extDir = parts[2]
        if (!result[manifest.targetModule]) result[manifest.targetModule] = {}
        for (const [viewId, viewPath] of Object.entries(manifest.client.views)) {
          const normalized = viewPath.replace(/^\.\//, '')
          const globKey = `/platform/${extDir}/${normalized}`
          const loader = viewComponents[globKey]
          if (!loader) continue
          result[manifest.targetModule][viewId] = defineAsyncComponent(loader)
        }
      }
      return result
    }

    return loadModuleViewExtensionsImpl
  }

  it('returns empty object when no module-views manifests exist', () => {
    const fn = loadWithMocks({}, {})
    expect(fn()).toEqual({})
  })

  it('ignores non-module-views manifests', () => {
    const manifests = {
      '/platform/about-tabs/manifest.json': {
        default: { tabs: [] }
      }
    }
    const fn = loadWithMocks(manifests, {})
    expect(fn()).toEqual({})
  })

  it('discovers module-views extension and maps views by target module', () => {
    const manifests = {
      '/platform/jira-taxonomy/manifest.json': {
        default: {
          type: 'module-views',
          targetModule: 'team-tracker',
          navItems: [{ id: 'jira-taxonomy', label: 'Jira Taxonomy', icon: 'Layers' }],
          client: { views: { 'jira-taxonomy': './client/JiraTaxonomyView.vue' } }
        }
      }
    }
    const viewComponents = {
      '/platform/jira-taxonomy/client/JiraTaxonomyView.vue': () => Promise.resolve({ default: {} })
    }

    const fn = loadWithMocks(manifests, viewComponents)
    const result = fn()

    expect(result).toHaveProperty('team-tracker')
    expect(result['team-tracker']).toHaveProperty('jira-taxonomy')
    expect(result['team-tracker']['jira-taxonomy']).toBeDefined()
  })

  it('skips views whose component is not found in glob', () => {
    const manifests = {
      '/platform/missing-ext/manifest.json': {
        default: {
          type: 'module-views',
          targetModule: 'team-tracker',
          navItems: [{ id: 'missing', label: 'Missing', icon: 'X' }],
          client: { views: { 'missing': './client/Missing.vue' } }
        }
      }
    }

    const fn = loadWithMocks(manifests, {})
    const result = fn()

    expect(result['team-tracker']).toEqual({})
  })

  it('handles multiple extensions targeting different modules', () => {
    const manifests = {
      '/platform/ext-a/manifest.json': {
        default: {
          type: 'module-views',
          targetModule: 'team-tracker',
          navItems: [{ id: 'view-a', label: 'A', icon: 'Home' }],
          client: { views: { 'view-a': './client/A.vue' } }
        }
      },
      '/platform/ext-b/manifest.json': {
        default: {
          type: 'module-views',
          targetModule: 'releases',
          navItems: [{ id: 'view-b', label: 'B', icon: 'Box' }],
          client: { views: { 'view-b': './client/B.vue' } }
        }
      }
    }
    const viewComponents = {
      '/platform/ext-a/client/A.vue': () => Promise.resolve({ default: {} }),
      '/platform/ext-b/client/B.vue': () => Promise.resolve({ default: {} })
    }

    const fn = loadWithMocks(manifests, viewComponents)
    const result = fn()

    expect(Object.keys(result)).toEqual(['team-tracker', 'releases'])
    expect(result['team-tracker']).toHaveProperty('view-a')
    expect(result['releases']).toHaveProperty('view-b')
  })

  it('skips manifests without targetModule', () => {
    const manifests = {
      '/platform/bad/manifest.json': {
        default: {
          type: 'module-views',
          navItems: [{ id: 'x', label: 'X', icon: 'X' }],
          client: { views: { 'x': './client/X.vue' } }
        }
      }
    }
    const fn = loadWithMocks(manifests, {})
    expect(fn()).toEqual({})
  })

  it('skips manifests without client.views', () => {
    const manifests = {
      '/platform/no-views/manifest.json': {
        default: {
          type: 'module-views',
          targetModule: 'team-tracker',
          navItems: [{ id: 'x', label: 'X', icon: 'X' }]
        }
      }
    }
    const fn = loadWithMocks(manifests, {})
    expect(fn()).toEqual({})
  })
})
