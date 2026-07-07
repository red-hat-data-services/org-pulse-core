#!/usr/bin/env node

const fs = require('fs')
const path = require('path')

const PLATFORM_DIR = path.join(__dirname, '..', 'platform')
const ABOUT_TABS_DIR = path.join(PLATFORM_DIR, 'about-tabs')

let errors = 0

function error(msg) {
  console.error(`  ERROR: ${msg}`)
  errors++
}

if (!fs.existsSync(PLATFORM_DIR)) {
  console.log('No platform/ directory found — skipping validation (core-only build)')
  process.exit(0)
}

// --- About Tabs Validation ---

const hasAboutTabs = fs.existsSync(ABOUT_TABS_DIR)
const ALLOCATION_DIR = path.join(PLATFORM_DIR, 'allocation-strategy')
const hasAllocation = fs.existsSync(ALLOCATION_DIR)

// Discover module-views extensions
const moduleViewsDirs = []
if (fs.existsSync(PLATFORM_DIR)) {
  for (const entry of fs.readdirSync(PLATFORM_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const manifestPath = path.join(PLATFORM_DIR, entry.name, 'manifest.json')
    if (!fs.existsSync(manifestPath)) continue
    try {
      const m = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
      if (m.type === 'module-views') moduleViewsDirs.push(entry.name)
    } catch { /* skip */ }
  }
}
const hasModuleViews = moduleViewsDirs.length > 0

if (!hasAboutTabs && !hasAllocation && !hasModuleViews) {
  console.log('No platform extensions found — skipping validation')
  process.exit(0)
}

if (!hasAboutTabs) {
  console.log('No platform/about-tabs/ — skipping about-tabs validation')
}

if (hasAboutTabs) {
  const manifestPath = path.join(ABOUT_TABS_DIR, 'manifest.json')
  if (!fs.existsSync(manifestPath)) {
    error('platform/about-tabs/manifest.json not found')
  } else {
    let manifest
    try {
      manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'))
    } catch (e) {
      error(`about-tabs manifest.json is not valid JSON: ${e.message}`)
    }

    if (manifest) {
      console.log('Validating platform/about-tabs/manifest.json...')

      if (!Array.isArray(manifest.tabs)) {
        error('"tabs" field must be an array')
      } else {
        const REQUIRED_TAB_FIELDS = ['id', 'label', 'icon', 'component']
        const seenIds = new Set()

        for (const tab of manifest.tabs) {
          for (const field of REQUIRED_TAB_FIELDS) {
            if (typeof tab[field] !== 'string' || !tab[field]) {
              error(`Tab "${tab.id || '(unnamed)'}" is missing required string field "${field}"`)
            }
          }

          if (tab.id) {
            if (seenIds.has(tab.id)) {
              error(`Duplicate tab ID: "${tab.id}"`)
            }
            seenIds.add(tab.id)
          }

          if (tab.component) {
            const componentPath = path.join(ABOUT_TABS_DIR, tab.component.replace(/^\.\//, ''))
            if (!fs.existsSync(componentPath)) {
              error(`Component file not found: ${tab.component} (expected at ${componentPath})`)
            }
          }

          if (tab.order !== undefined && typeof tab.order !== 'number') {
            error(`Tab "${tab.id}": "order" must be a number`)
          }

          if (tab.requireRole !== undefined && typeof tab.requireRole !== 'string') {
            error(`Tab "${tab.id}": "requireRole" must be a string`)
          }
        }

        if (errors === 0) {
          console.log(`  ${manifest.tabs.length} tab(s) validated successfully`)
        }
      }
    }
  }
}

// --- Allocation Strategy Validation ---

if (hasAllocation) {
  const allocManifestPath = path.join(ALLOCATION_DIR, 'manifest.json')
  if (!fs.existsSync(allocManifestPath)) {
    error('platform/allocation-strategy/manifest.json not found')
  } else {
    let allocManifest
    try {
      allocManifest = JSON.parse(fs.readFileSync(allocManifestPath, 'utf-8'))
    } catch (e) {
      error(`allocation-strategy manifest.json is not valid JSON: ${e.message}`)
    }

    if (allocManifest) {
      console.log('Validating platform/allocation-strategy/manifest.json...')

      const REQUIRED_FIELDS = ['id', 'name', 'categories', 'classify']
      for (const field of REQUIRED_FIELDS) {
        if (!allocManifest[field]) {
          error(`allocation-strategy manifest missing required field "${field}"`)
        }
      }

      if (!Array.isArray(allocManifest.categories)) {
        error('"categories" must be an array')
      } else {
        const REQUIRED_CAT_FIELDS = ['key', 'name', 'color', 'target']
        for (const cat of allocManifest.categories) {
          for (const field of REQUIRED_CAT_FIELDS) {
            if (cat[field] === undefined || cat[field] === null || cat[field] === '') {
              error(`Category "${cat.key || '(unnamed)'}" missing required field "${field}"`)
            }
          }
          if (typeof cat.target !== 'number') {
            error(`Category "${cat.key}": "target" must be a number`)
          }
        }

        const targetSum = allocManifest.categories.reduce((sum, c) => sum + (c.target || 0), 0)
        if (targetSum !== 100) {
          console.warn(`  WARNING: Category targets sum to ${targetSum}, expected 100`)
        }
      }

      if (allocManifest.classify) {
        const classifyFile = allocManifest.classify.replace(/^\.\//, '')
        const classifyPath = path.join(ALLOCATION_DIR, classifyFile)
        if (!fs.existsSync(classifyPath)) {
          error(`classify file not found: ${allocManifest.classify} (expected at ${classifyPath})`)
        }
      }

      if (allocManifest.settingsComponent) {
        const settingsFile = allocManifest.settingsComponent.replace(/^\.\//, '')
        const settingsPath = path.join(ALLOCATION_DIR, settingsFile)
        if (!fs.existsSync(settingsPath)) {
          error(`settingsComponent file not found: ${allocManifest.settingsComponent} (expected at ${settingsPath})`)
        }
      }

      if (errors === 0) {
        console.log(`  Strategy "${allocManifest.id}" with ${allocManifest.categories?.length || 0} categories validated successfully`)
      }
    }
  }
}

// --- Module-Views Validation ---

for (const dirName of moduleViewsDirs) {
  const extDir = path.join(PLATFORM_DIR, dirName)
  const manifestPath = path.join(extDir, 'manifest.json')
  let manifest
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  } catch (e) {
    error(`${dirName}/manifest.json is not valid JSON: ${e.message}`)
    continue
  }

  console.log(`Validating platform/${dirName}/manifest.json (module-views)...`)

  if (!manifest.targetModule || typeof manifest.targetModule !== 'string') {
    error(`${dirName}: "targetModule" must be a non-empty string`)
  }

  if (!Array.isArray(manifest.navItems) || manifest.navItems.length === 0) {
    error(`${dirName}: "navItems" must be a non-empty array`)
  } else {
    const REQUIRED_NAV_FIELDS = ['id', 'label', 'icon']
    const seenIds = new Set()

    for (const item of manifest.navItems) {
      for (const field of REQUIRED_NAV_FIELDS) {
        if (typeof item[field] !== 'string' || !item[field]) {
          error(`${dirName}: navItem "${item.id || '(unnamed)'}" missing required string field "${field}"`)
        }
      }
      if (item.id) {
        if (seenIds.has(item.id)) {
          error(`${dirName}: duplicate navItem ID "${item.id}"`)
        }
        seenIds.add(item.id)
      }
      if (item.order !== undefined && typeof item.order !== 'number') {
        error(`${dirName}: navItem "${item.id}": "order" must be a number`)
      }
    }
  }

  if (!manifest.client || !manifest.client.views || typeof manifest.client.views !== 'object' || Array.isArray(manifest.client.views)) {
    error(`${dirName}: "client.views" is required and must be an object`)
  } else {
    for (const [viewId, viewPath] of Object.entries(manifest.client.views)) {
      if (typeof viewPath !== 'string') {
        error(`${dirName}: client.views["${viewId}"] must be a string path`)
        continue
      }
      const normalized = viewPath.replace(/^\.\//, '')
      const fullPath = path.join(extDir, normalized)
      if (!fs.existsSync(fullPath)) {
        error(`${dirName}: client view file not found: ${viewPath} (expected at ${fullPath})`)
      }
      // Each view should have a corresponding navItem
      const navIds = (manifest.navItems || []).map(n => n.id)
      if (!navIds.includes(viewId)) {
        console.warn(`  WARNING: ${dirName}: client view "${viewId}" has no matching navItem`)
      }
    }
  }

  if (manifest.server && manifest.server.entry) {
    const entryFile = manifest.server.entry.replace(/^\.\//, '')
    const entryPath = path.join(extDir, entryFile)
    if (!fs.existsSync(entryPath)) {
      error(`${dirName}: server entry not found: ${manifest.server.entry} (expected at ${entryPath})`)
    }
  }

  if (errors === 0) {
    console.log(`  Extension "${dirName}" → ${manifest.targetModule}: ${manifest.navItems?.length || 0} navItem(s) validated successfully`)
  }
}

// --- Final Result ---

if (errors > 0) {
  console.error(`\n${errors} error(s) found in platform manifests`)
  process.exit(1)
}
