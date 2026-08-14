/**
 * Tests for server-side platform extension discovery, focused on the
 * "module-views" extension contract — in particular that an extension may be
 * server-only (backend routes, no navItems/client.views) so its UI can be
 * registered through a module's contribution seam instead of the sidebar.
 */

const fs = require('fs')
const os = require('os')
const path = require('path')
const { loadModuleViewExtensions } = require('../platform-loader')

function writeExt(platformDir, name, manifest, { serverEntry = false } = {}) {
  const dir = path.join(platformDir, name)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest))
  if (serverEntry) {
    fs.writeFileSync(path.join(dir, 'index.js'), 'module.exports = function () {}\n')
  }
  return dir
}

describe('loadModuleViewExtensions', () => {
  let platformDir

  beforeEach(() => {
    platformDir = fs.mkdtempSync(path.join(os.tmpdir(), 'platform-loader-'))
  })

  afterEach(() => {
    fs.rmSync(platformDir, { recursive: true, force: true })
  })

  it('discovers a nav-only extension', () => {
    writeExt(platformDir, 'jira-taxonomy', {
      type: 'module-views',
      targetModule: 'team-tracker',
      navItems: [{ id: 'jira-taxonomy', label: 'Jira Taxonomy', icon: 'Layers' }],
      client: { views: { 'jira-taxonomy': './client/View.vue' } },
    })

    const exts = loadModuleViewExtensions(platformDir)
    expect(exts).toHaveLength(1)
    expect(exts[0].id).toBe('jira-taxonomy')
    expect(exts[0].navItems).toHaveLength(1)
    expect(exts[0].serverEntry).toBeNull()
  })

  it('discovers a server-only extension with no navItems (contribution-seam UI)', () => {
    writeExt(platformDir, 'allocation', {
      type: 'module-views',
      targetModule: 'team-tracker',
      server: { entry: './index.js' },
    }, { serverEntry: true })

    const exts = loadModuleViewExtensions(platformDir)
    expect(exts).toHaveLength(1)
    expect(exts[0].id).toBe('allocation')
    expect(exts[0].navItems).toEqual([])
    expect(exts[0].serverEntry).toBe(path.join(platformDir, 'allocation', 'index.js'))
  })

  it('skips an extension that contributes nothing (no navItems and no server entry)', () => {
    writeExt(platformDir, 'empty', {
      type: 'module-views',
      targetModule: 'team-tracker',
    })

    expect(loadModuleViewExtensions(platformDir)).toEqual([])
  })

  it('skips an extension whose declared server entry is missing', () => {
    writeExt(platformDir, 'broken', {
      type: 'module-views',
      targetModule: 'team-tracker',
      server: { entry: './index.js' },
    }) // note: serverEntry file NOT written

    expect(loadModuleViewExtensions(platformDir)).toEqual([])
  })

  it('skips an extension missing targetModule', () => {
    writeExt(platformDir, 'no-target', {
      type: 'module-views',
      navItems: [{ id: 'x', label: 'X', icon: 'Layers' }],
      client: { views: { x: './client/View.vue' } },
    })

    expect(loadModuleViewExtensions(platformDir)).toEqual([])
  })
})
