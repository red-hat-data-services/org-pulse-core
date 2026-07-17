import { describe, it, expect, vi } from 'vitest'


function makeStorage(initial = {}) {
  const data = { ...initial }
  return {
    async readFromStorage(key) { return data[key] ? JSON.parse(JSON.stringify(data[key])) : null },
    writeToStorage: vi.fn(async (key, val) => { data[key] = JSON.parse(JSON.stringify(val)) }),
    listStorageFiles: vi.fn(async (dir) => {
      return Object.keys(data)
        .filter(k => k.startsWith(dir + '/') && k.endsWith('.json'))
        .map(k => k.split('/').pop())
    }),
    deleteStorageDirectory: vi.fn().mockResolvedValue(),
    _data: data
  }
}

async function setupRoutes(storageData) {
  const handlers = {}
  const mockRouter = {
    get(path, ...args) { handlers[`GET ${path}`] = args[args.length - 1] },
    post(path, ...args) { handlers[`POST ${path}`] = args[args.length - 1] },
    put(path, ...args) { handlers[`PUT ${path}`] = args[args.length - 1] },
    patch(path, ...args) { handlers[`PATCH ${path}`] = args[args.length - 1] },
    delete(path, ...args) { handlers[`DELETE ${path}`] = args[args.length - 1] }
  }

  const storage = makeStorage(storageData)
  const context = {
    storage,
    requireAdmin: (req, res, next) => next(),
    requireTeamAdmin: (req, res, next) => next(),
    requireScope: () => (req, res, next) => next(),
    roleStore: {
      getRoles: vi.fn(() => []),
      isAdmin: vi.fn(() => false),
      isTeamAdmin: vi.fn(() => false)
    },
    registerScopes: vi.fn()
  }

  const registerRoutes = require('../../server/index.js')
  await registerRoutes(mockRouter, context)

  return { handlers, storage }
}

function mockRes() {
  const res = {
    _status: 200,
    _body: null,
    status(code) { res._status = code; return res },
    json(body) { res._body = body; return res }
  }
  return res
}

function baseStorageData() {
  return {
    'team-data/registry.json': {
      meta: { generatedAt: '2026-01-01', provider: 'test', orgRoots: ['org1'] },
      people: {}
    },
    'team-data/teams.json': { teams: {} },
    'team-data/field-definitions.json': { personFields: [], teamFields: [] },
    'team-data/config.json': { orgRoots: [], teamDataSource: 'in-app' },
    'audit-log.json': { entries: [] },
    'people/alice_smith.json': {
      jiraDisplayName: 'Alice Smith',
      fetchedAt: '2026-01-01T00:00:00.000Z',
      resolved: { count: 10, storyPoints: 20, issues: [] },
      inProgress: { count: 2, storyPoints: 5, issues: [] },
      cycleTime: { avgDays: 3.0, medianDays: 2.5 }
    },
    'people/bob_jones.json': {
      jiraDisplayName: 'Bob Jones',
      fetchedAt: '2026-01-01T00:00:00.000Z',
      resolved: { count: 5, storyPoints: 8, issues: [] },
      inProgress: { count: 1, storyPoints: 3, issues: [] },
      cycleTime: { avgDays: 4.0, medianDays: 3.0 }
    }
  }
}

describe('POST /person/metrics/batch', () => {
  it('returns metrics for valid names', async () => {
    const { handlers } = await setupRoutes(baseStorageData())
    const res = mockRes()
    const req = { body: { names: ['Alice Smith', 'Bob Jones'] } }

    await handlers['POST /person/metrics/batch'](req, res)

    expect(res._status).toBe(200)
    expect(res._body.results['Alice Smith'].jiraDisplayName).toBe('Alice Smith')
    expect(res._body.results['Alice Smith'].resolved.count).toBe(10)
    expect(res._body.results['Bob Jones'].jiraDisplayName).toBe('Bob Jones')
    expect(res._body.results['Bob Jones'].resolved.count).toBe(5)
  })

  it('returns null for unknown names', async () => {
    const { handlers } = await setupRoutes(baseStorageData())
    const res = mockRes()
    const req = { body: { names: ['Alice Smith', 'Nobody'] } }

    await handlers['POST /person/metrics/batch'](req, res)

    expect(res._status).toBe(200)
    expect(res._body.results['Alice Smith']).not.toBeNull()
    expect(res._body.results['Nobody']).toBeNull()
  })

  it('rejects non-array input', async () => {
    const { handlers } = await setupRoutes(baseStorageData())
    const res = mockRes()
    const req = { body: { names: 'not an array' } }

    await handlers['POST /person/metrics/batch'](req, res)

    expect(res._status).toBe(400)
    expect(res._body.error).toMatch(/must be an array/)
  })

  it('rejects array with non-string elements', async () => {
    const { handlers } = await setupRoutes(baseStorageData())
    const res = mockRes()
    const req = { body: { names: ['Alice Smith', 123, null] } }

    await handlers['POST /person/metrics/batch'](req, res)

    expect(res._status).toBe(400)
    expect(res._body.error).toMatch(/must be an array/)
  })

  it('rejects oversized input', async () => {
    const { handlers } = await setupRoutes(baseStorageData())
    const res = mockRes()
    const names = Array.from({ length: 201 }, (_, i) => `Person ${i}`)
    const req = { body: { names } }

    await handlers['POST /person/metrics/batch'](req, res)

    expect(res._status).toBe(400)
    expect(res._body.error).toMatch(/Too many names/)
  })

  it('returns empty results for empty array', async () => {
    const { handlers } = await setupRoutes(baseStorageData())
    const res = mockRes()
    const req = { body: { names: [] } }

    await handlers['POST /person/metrics/batch'](req, res)

    expect(res._status).toBe(200)
    expect(res._body.results).toEqual({})
  })
})
