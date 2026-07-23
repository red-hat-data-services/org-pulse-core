const fs = require('fs')
const fsp = require('fs').promises
const path = require('path')

async function seedFixtures(connection, modules, fixturesDirs) {
  if (!connection || connection.readyState !== 1) return

  let totalSeeded = 0

  for (const mod of modules) {
    if (!mod.fixtures) continue

    const slug = mod.slug
    for (const [fixtureFile, collectionName] of Object.entries(mod.fixtures)) {
      const fullCollectionName = slug + '__' + collectionName
      const data = await loadFixtureFile(fixtureFile, mod, fixturesDirs)
      if (data === null) continue

      const docs = Array.isArray(data) ? data : [data]
      if (docs.length === 0) continue

      const collection = connection.db.collection(fullCollectionName)
      await collection.deleteMany({})
      await collection.insertMany(docs)
      totalSeeded += docs.length
    }
  }

  if (totalSeeded > 0) {
    console.log(`[fixture-seeder] Seeded ${totalSeeded} documents into MongoDB`)
  }
}

async function loadFixtureFile(fixtureFile, mod, fixturesDirs) {
  // Try module-local fixtures directory first (relative to module root)
  if (mod.dir) {
    const localPath = path.join(mod.dir, 'fixtures', fixtureFile)
    if (fs.existsSync(localPath)) {
      const raw = await fsp.readFile(localPath, 'utf8')
      return JSON.parse(raw)
    }
  }

  // Fall back to global fixture dirs (slug-prefixed)
  for (const dir of fixturesDirs) {
    const globalPath = path.join(dir, mod.slug, fixtureFile)
    if (fs.existsSync(globalPath)) {
      const raw = await fsp.readFile(globalPath, 'utf8')
      return JSON.parse(raw)
    }
    // Also try without slug prefix for core fixtures
    const flatPath = path.join(dir, fixtureFile)
    if (fs.existsSync(flatPath)) {
      const raw = await fsp.readFile(flatPath, 'utf8')
      return JSON.parse(raw)
    }
  }

  return null
}

module.exports = { seedFixtures }
