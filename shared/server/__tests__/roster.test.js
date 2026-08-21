import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import mongoose from 'mongoose'

const { splitByKnownNames, getTeamRollup, collectRoleNames, readRosterFull, getAllPeople } = require('../roster')
const { createRegistryStore } = require('../registry-store')
const { registryEntrySchema } = require('../models/registry-entry')

describe('splitByKnownNames', () => {
  const knownNames = new Set([
    'Yuan Tang',
    'Pierangelo Di Pilato',
    'Lindani Phiri',
    'Steven Grubb',
    'Adam Bellusci',
    'Naina Singh',
    'Jonathan Zarecki'
  ])

  it('returns a single known name unchanged', () => {
    expect(splitByKnownNames('Yuan Tang', knownNames)).toEqual(['Yuan Tang'])
  })

  it('splits two concatenated names', () => {
    expect(splitByKnownNames('Pierangelo Di Pilato Yuan Tang', knownNames))
      .toEqual(['Pierangelo Di Pilato', 'Yuan Tang'])
  })

  it('splits three concatenated names', () => {
    expect(splitByKnownNames('Adam Bellusci Naina Singh Jonathan Zarecki', knownNames))
      .toEqual(['Adam Bellusci', 'Naina Singh', 'Jonathan Zarecki'])
  })

  it('returns unknown names as-is', () => {
    expect(splitByKnownNames('Someone Unknown', knownNames))
      .toEqual(['Someone Unknown'])
  })

  it('returns original string when only partial match at start', () => {
    expect(splitByKnownNames('Yuan Tang Unknown Person', knownNames))
      .toEqual(['Yuan Tang Unknown Person'])
  })

  it('handles empty knownNames set', () => {
    expect(splitByKnownNames('Yuan Tang', new Set())).toEqual(['Yuan Tang'])
  })

  it('prefers longer name match (greedy longest-first)', () => {
    const names = new Set(['John', 'John Smith', 'Anna Brown'])
    expect(splitByKnownNames('John Smith Anna Brown', names))
      .toEqual(['John Smith', 'Anna Brown'])
  })

  it('handles extra whitespace between names', () => {
    expect(splitByKnownNames('Yuan Tang  Lindani Phiri', knownNames))
      .toEqual(['Yuan Tang', 'Lindani Phiri'])
  })
})

describe('getTeamRollup with knownNames', () => {
  const knownNames = new Set([
    'Yuan Tang',
    'Pierangelo Di Pilato',
    'Adam Bellusci',
    'Naina Singh'
  ])

  it('splits concatenated names when knownNames provided', () => {
    const people = [
      { name: 'Alice', engineeringLead: 'Pierangelo Di Pilato Yuan Tang' },
      { name: 'Bob', engineeringLead: 'Yuan Tang' }
    ]
    const result = getTeamRollup(people, 'engineeringLead', knownNames)
    expect(result).toEqual(['Pierangelo Di Pilato', 'Yuan Tang'])
  })

  it('handles mix of comma-separated and concatenated names', () => {
    const people = [
      { name: 'Alice', productManager: 'Adam Bellusci, Naina Singh' },
      { name: 'Bob', productManager: 'Adam Bellusci Naina Singh' }
    ]
    const result = getTeamRollup(people, 'productManager', knownNames)
    expect(result).toEqual(['Adam Bellusci', 'Naina Singh'])
  })

  it('works without knownNames (backward compatible)', () => {
    const people = [
      { name: 'Alice', engineeringLead: 'Pierangelo Di Pilato Yuan Tang' }
    ]
    const result = getTeamRollup(people, 'engineeringLead')
    expect(result).toEqual(['Pierangelo Di Pilato Yuan Tang'])
  })

  it('deduplicates across people', () => {
    const people = [
      { name: 'Alice', engineeringLead: 'Yuan Tang' },
      { name: 'Bob', engineeringLead: 'Yuan Tang' },
      { name: 'Carol', engineeringLead: 'Adam Bellusci Yuan Tang' }
    ]
    const result = getTeamRollup(people, 'engineeringLead', knownNames)
    expect(result).toEqual(['Adam Bellusci', 'Yuan Tang'])
  })

  it('returns sorted results', () => {
    const people = [
      { name: 'Alice', engineeringLead: 'Yuan Tang Adam Bellusci' }
    ]
    const result = getTeamRollup(people, 'engineeringLead', knownNames)
    expect(result).toEqual(['Adam Bellusci', 'Yuan Tang'])
  })

  it('skips empty and null values', () => {
    const people = [
      { name: 'Alice', engineeringLead: '' },
      { name: 'Bob', engineeringLead: null },
      { name: 'Carol' }
    ]
    const result = getTeamRollup(people, 'engineeringLead', knownNames)
    expect(result).toEqual([])
  })
})

describe('collectRoleNames', () => {
  it('discovers PM names not in the roster from field values', () => {
    const people = [
      { name: 'Alice', productManager: 'Adam Bellusci' },
      { name: 'Bob', productManager: 'Adam Bellusci Naina Singh' },
      { name: 'Carol', productManager: 'Naina Singh' }
    ]
    const rosterNames = new Set(['Alice', 'Bob', 'Carol'])
    const result = collectRoleNames(people, ['productManager'], rosterNames)
    expect(result.has('Adam Bellusci')).toBe(true)
    expect(result.has('Naina Singh')).toBe(true)
    expect(result.has('Adam Bellusci Naina Singh')).toBe(false)
  })

  it('discovers names from three-name concatenations', () => {
    const people = [
      { name: 'Alice', productManager: 'Adam Bellusci' },
      { name: 'Bob', productManager: 'Naina Singh' },
      { name: 'Carol', productManager: 'Adam Bellusci Naina Singh Jonathan Zarecki' },
      { name: 'Dave', productManager: 'Jonathan Zarecki' }
    ]
    const result = collectRoleNames(people, ['productManager'], new Set())
    expect(result.has('Adam Bellusci')).toBe(true)
    expect(result.has('Naina Singh')).toBe(true)
    expect(result.has('Jonathan Zarecki')).toBe(true)
    expect(result.has('Adam Bellusci Naina Singh Jonathan Zarecki')).toBe(false)
  })

  it('preserves multi-word names that cannot be decomposed', () => {
    const people = [
      { name: 'Alice', engineeringLead: 'Pierangelo Di Pilato' },
      { name: 'Bob', engineeringLead: 'Pierangelo Di Pilato Yuan Tang' }
    ]
    const rosterNames = new Set(['Alice', 'Bob', 'Yuan Tang'])
    const result = collectRoleNames(people, ['engineeringLead'], rosterNames)
    expect(result.has('Pierangelo Di Pilato')).toBe(true)
    expect(result.has('Yuan Tang')).toBe(true)
  })

  it('includes existing roster names in the result', () => {
    const people = [{ name: 'Alice', productManager: 'Some PM' }]
    const rosterNames = new Set(['Alice', 'Bob'])
    const result = collectRoleNames(people, ['productManager'], rosterNames)
    expect(result.has('Alice')).toBe(true)
    expect(result.has('Bob')).toBe(true)
    expect(result.has('Some PM')).toBe(true)
  })

  it('handles comma-separated values correctly', () => {
    const people = [
      { name: 'Alice', productManager: 'Adam Bellusci, Naina Singh' },
      { name: 'Bob', productManager: 'Adam Bellusci Naina Singh' }
    ]
    const result = collectRoleNames(people, ['productManager'], new Set())
    expect(result.has('Adam Bellusci')).toBe(true)
    expect(result.has('Naina Singh')).toBe(true)
  })

  it('scans multiple fields', () => {
    const people = [
      { name: 'Alice', engineeringLead: 'Lead One', productManager: 'PM One' },
      { name: 'Bob', engineeringLead: 'Lead One Lead Two', productManager: 'PM One PM Two' },
      { name: 'Carol', engineeringLead: 'Lead Two', productManager: 'PM Two' }
    ]
    const result = collectRoleNames(people, ['engineeringLead', 'productManager'], new Set())
    expect(result.has('Lead One')).toBe(true)
    expect(result.has('Lead Two')).toBe(true)
    expect(result.has('PM One')).toBe(true)
    expect(result.has('PM Two')).toBe(true)
  })

  it('cannot discover names that only appear concatenated', () => {
    const people = [
      { name: 'Alice', productManager: 'Adam Bellusci Naina Singh' }
    ]
    const result = collectRoleNames(people, ['productManager'], new Set())
    expect(result.has('Adam Bellusci Naina Singh')).toBe(true)
    expect(result.has('Adam Bellusci')).toBe(false)
    expect(result.has('Naina Singh')).toBe(false)
  })

  it('handles empty field values gracefully', () => {
    const people = [
      { name: 'Alice', productManager: '' },
      { name: 'Bob', productManager: null },
      { name: 'Carol' }
    ]
    const result = collectRoleNames(people, ['productManager'], new Set())
    expect(result.size).toBe(0)
  })

  it('reads from customFields fallback', () => {
    const people = [
      { name: 'Alice', customFields: { productManager: 'Custom PM' } }
    ]
    const result = collectRoleNames(people, ['productManager'], new Set())
    expect(result.has('Custom PM')).toBe(true)
  })
})

// ─── readRosterFull / getAllPeople dual-path parity ───

function createMockStorage(initialData = {}) {
  const store = {}
  for (const [key, val] of Object.entries(initialData)) {
    store[key] = JSON.parse(JSON.stringify(val))
  }
  return {
    async readFromStorage(key) { return store[key] ? JSON.parse(JSON.stringify(store[key])) : null },
    async writeToStorage(key, data) { store[key] = JSON.parse(JSON.stringify(data)) },
    _store: store
  }
}

const sampleRegistry = {
  meta: { generatedAt: '2026-01-01T00:00:00.000Z', vp: { uid: 'vp1', name: 'VP One' } },
  people: {
    achen: {
      uid: 'achen', name: 'Alice Chen', status: 'active', orgRoot: 'achen',
      github: { username: 'alicechen', source: 'ldap' }, gitlab: null
    },
    bsmith: {
      uid: 'bsmith', name: 'Bob Smith', status: 'active', orgRoot: 'achen',
      github: null, gitlab: { username: 'bobsmith', source: 'ldap' }
    },
    inactive1: { uid: 'inactive1', name: 'Gone', status: 'inactive', orgRoot: 'achen' }
  }
}

describe('readRosterFull (file path)', () => {
  it('returns null when the registry is missing', async () => {
    const storage = createMockStorage({})
    expect(await readRosterFull(storage)).toBeNull()
  })

  it('groups active people by orgRoot and flattens github/gitlab usernames', async () => {
    const storage = createMockStorage({ 'team-data/registry.json': sampleRegistry })
    const roster = await readRosterFull(storage)
    expect(roster.orgs.achen.members.map(m => m.uid).sort()).toEqual(['achen', 'bsmith'])
    const achen = roster.orgs.achen.members.find(m => m.uid === 'achen')
    expect(achen.githubUsername).toBe('alicechen')
    expect(achen.gitlabUsername).toBeNull()
  })

  it('getAllPeople excludes inactive people', async () => {
    const storage = createMockStorage({ 'team-data/registry.json': sampleRegistry })
    const people = await getAllPeople(storage)
    expect(people.map(p => p.uid).sort()).toEqual(['achen', 'bsmith'])
  })
})

describe('readRosterFull / getAllPeople (MongoDB registry)', () => {
  let connection
  let RegistryModel
  const dbName = 'test_roster_' + process.pid

  beforeAll(async () => {
    const uri = process.env.MONGODB_URI
    if (!uri) return
    connection = await mongoose.createConnection(uri, { dbName })
    RegistryModel = connection.model('core__registry_entries', registryEntrySchema, 'core__registry_entries')
  })

  afterAll(async () => {
    if (connection) {
      await connection.db.dropDatabase()
      await connection.close()
    }
  })

  beforeEach(async () => {
    if (RegistryModel) await RegistryModel.deleteMany({})
  })

  function makeRegistryStore() {
    if (!RegistryModel) return null
    const storage = createMockStorage({})
    return { registryStore: createRegistryStore(storage, { model: RegistryModel }), storage }
  }

  it.skipIf(!process.env.MONGODB_URI)('returns the same shape as the file path for the same data', async () => {
    const result = makeRegistryStore()
    if (!result) return
    const { registryStore, storage } = result
    await registryStore.writeRegistry(sampleRegistry)

    const fileRoster = await readRosterFull(createMockStorage({ 'team-data/registry.json': sampleRegistry }))
    const dbRoster = await readRosterFull(storage, registryStore)
    expect(dbRoster).toEqual(fileRoster)
  })

  it.skipIf(!process.env.MONGODB_URI)('getAllPeople excludes inactive people on the MongoDB path', async () => {
    const result = makeRegistryStore()
    if (!result) return
    const { registryStore, storage } = result
    await registryStore.writeRegistry(sampleRegistry)

    const people = await getAllPeople(storage, registryStore)
    expect(people.map(p => p.uid).sort()).toEqual(['achen', 'bsmith'])
  })
})
