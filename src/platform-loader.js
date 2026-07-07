import { defineAsyncComponent } from 'vue'

const aboutTabManifests = import.meta.glob('/platform/*/manifest.json', { eager: true })
const aboutTabComponents = import.meta.glob('/platform/about-tabs/*.vue')
const allocationStrategyComponents = import.meta.glob('/platform/allocation-strategy/*.vue')
const moduleViewComponents = import.meta.glob('/platform/*/client/**/*.vue')

export function loadPlatformAboutTabs() {
  const manifest = aboutTabManifests['/platform/about-tabs/manifest.json']
  if (!manifest) return []
  const tabs = (manifest.default || manifest).tabs || []
  return tabs.map(tab => {
    const normalized = tab.component.replace(/^\.\//, '')
    const globKey = `/platform/about-tabs/${normalized}`
    const loader = aboutTabComponents[globKey]
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

/**
 * Discover module-view extensions and return a map of target module slug
 * to an object of { viewId: asyncComponent }.
 * @returns {Object<string, Object<string, import('vue').Component>>}
 */
export function loadModuleViewExtensions() {
  const result = {}
  for (const [manifestPath, raw] of Object.entries(aboutTabManifests)) {
    const manifest = raw.default || raw
    if (manifest.type !== 'module-views') continue
    if (!manifest.targetModule || !manifest.client?.views) continue

    // Derive the extension directory name from the manifest path
    // e.g., '/platform/jira-taxonomy/manifest.json' → 'jira-taxonomy'
    const parts = manifestPath.split('/')
    const extDir = parts[2] // '/platform/<dir>/manifest.json'

    if (!result[manifest.targetModule]) {
      result[manifest.targetModule] = {}
    }

    for (const [viewId, viewPath] of Object.entries(manifest.client.views)) {
      const normalized = viewPath.replace(/^\.\//, '')
      const globKey = `/platform/${extDir}/${normalized}`
      const loader = moduleViewComponents[globKey]
      if (!loader) {
        console.warn(`[platform] module-views component not found: ${globKey}`)
        continue
      }
      result[manifest.targetModule][viewId] = defineAsyncComponent(loader)
    }
  }
  return result
}

export function loadAllocationStrategy() {
  const manifest = aboutTabManifests['/platform/allocation-strategy/manifest.json']
  if (!manifest) return null
  const data = manifest.default || manifest
  const result = {
    id: data.id,
    name: data.name,
    description: data.description || '',
    categories: data.categories || []
  }
  if (data.settingsComponent) {
    const normalized = data.settingsComponent.replace(/^\.\//, '')
    const globKey = `/platform/allocation-strategy/${normalized}`
    const loader = allocationStrategyComponents[globKey]
    if (loader) {
      result.settingsComponent = defineAsyncComponent(loader)
    }
  }
  return result
}
