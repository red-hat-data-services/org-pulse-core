/**
 * Server-side platform extension discovery.
 *
 * Extends the platform/ directory pattern (established for frontend-only
 * extensions like about-tabs) to support server-side hooks. Supports:
 * - Module view extensions (inject views + routes into core modules)
 */

const fs = require('fs')
const path = require('path')

const DEFAULT_PLATFORM_DIR = path.join(__dirname, '..', 'platform')

/**
 * Discover module-view extensions from platform directories.
 * Scans manifest.json files in platform subdirectories for type "module-views".
 *
 * @param {string|string[]} [platformDirs] - Single directory or array of directories to search.
 * @returns {Array} Array of extension objects with id, targetModule, navItems, serverEntry, _dir.
 */
function loadModuleViewExtensions(platformDirs) {
  const dirs = platformDirs
    ? (Array.isArray(platformDirs) ? platformDirs : [platformDirs])
    : [DEFAULT_PLATFORM_DIR]

  const extensions = []
  const seenIds = new Set()

  for (const platformDir of dirs) {
    if (!fs.existsSync(platformDir)) continue

    for (const entry of fs.readdirSync(platformDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      if (entry.name.startsWith('.') || entry.name.startsWith('_')) continue

      const extDir = path.join(platformDir, entry.name)
      const manifestPath = path.join(extDir, 'manifest.json')
      if (!fs.existsSync(manifestPath)) continue

      let manifest
      try {
        manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'))
      } catch (err) {
        console.error(`[platform-loader] Failed to parse ${entry.name}/manifest.json:`, err.message)
        continue
      }

      if (manifest.type !== 'module-views') continue

      if (!manifest.targetModule || typeof manifest.targetModule !== 'string') {
        console.error(`[platform-loader] module-views extension "${entry.name}" missing targetModule`)
        continue
      }

      const id = entry.name
      if (seenIds.has(id)) {
        console.warn(`[platform-loader] Duplicate module-views extension "${id}", skipping`)
        continue
      }
      seenIds.add(id)

      const navItems = Array.isArray(manifest.navItems) ? manifest.navItems : []

      // Validate server entry if declared
      let serverEntry = null
      if (manifest.server && manifest.server.entry) {
        const entryFile = manifest.server.entry.replace(/^\.\//, '')
        const entryPath = path.join(extDir, entryFile)
        const resolvedEntry = path.resolve(entryPath)
        if (!resolvedEntry.startsWith(extDir + path.sep) && resolvedEntry !== extDir) {
          console.error(`[platform-loader] module-views extension "${id}": server entry escapes extension directory`)
          continue
        }
        if (!fs.existsSync(entryPath)) {
          console.error(`[platform-loader] module-views extension "${id}": server entry not found: ${entryPath}`)
          continue
        }
        serverEntry = entryPath
      }

      // A module-views extension must contribute something: nav items (which
      // render frontend views) and/or a server entry (backend routes). An
      // extension whose UI is registered through the target module's
      // contribution seam legitimately has no navItems/client.views here — it
      // just needs a server entry to be discovered by this (server-side) loader.
      if (navItems.length === 0 && !serverEntry) {
        console.error(`[platform-loader] module-views extension "${id}" contributes nothing (no navItems and no server.entry), skipping`)
        continue
      }

      extensions.push({
        id: id,
        targetModule: manifest.targetModule,
        navItems: navItems,
        serverEntry: serverEntry,
        secrets: manifest.secrets || null,
        _dir: extDir
      })

      console.log(`[platform-loader] Discovered module-views extension "${id}" → ${manifest.targetModule}`)
    }
  }

  return extensions
}

module.exports = { loadModuleViewExtensions }
