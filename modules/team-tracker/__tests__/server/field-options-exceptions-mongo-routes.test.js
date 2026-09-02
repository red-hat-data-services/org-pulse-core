const { createAuditLog } = require('../../../../shared/server/audit-log')
const { createConfigStore } = require('../../../../shared/server/config-store')
const { createFieldStore } = require('../../../../shared/server/field-store')
const { createRegistryStore } = require('../../../../shared/server/registry-store')
const { createTeamStore } = require('../../../../shared/server/team-store')
const { createScopedDb } = require('../../../../shared/server/scoped-db')
const { seedFixtures } = require('../../../../shared/server/fixture-seeder')
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import mongoose from 'mongoose'

function createStorage(initial = {}) {
  const data = structuredClone(initial)
  return {
    readFromStorage: vi.fn(async key => data[key] ? structuredClone(data[key]) : null),
    writeToStorage: vi.fn(async (key, value) => { data[key] = structuredClone(value) }),
    deleteStorageDirectory: vi.fn(async () => ({ deleted: 0 })),
    listStorageFiles: vi.fn(async () => []),
    data
  }
}

function createRouter() {
  const handlers = {}
  const router = {}
  for (const method of ['get', 'post', 'put', 'patch', 'delete']) {
    router[method] = (path, ...callbacks) => { handlers[`${method.toUpperCase()} ${path}`] = callbacks.at(-1) }
  }
  return { router, handlers }
}

function response() {
  const res = {
    statusCode: 200,
    body: null,
    status(code) { res.statusCode = code; return res },
    json(body) { res.body = body; return res }
  }
  return res
}

async function register(storage, db) {
  const { router, handlers } = createRouter()
  const auditLog = createAuditLog(storage)
  const registryStore = createRegistryStore(storage)
  await require('../../server/index.js')(router, {
    storage,
    db,
    auditLog,
    registryStore,
    configStore: createConfigStore(storage),
    fieldStore: createFieldStore(storage, { auditLog, registryStore }),
    teamStore: createTeamStore(storage, { auditLog, registryStore }),
    requireAdmin: (_req, _res, next) => next(),
    requireTeamAdmin: (_req, _res, next) => next(),
    requireScope: () => (_req, _res, next) => next(),
    registerScopes: vi.fn()
  })
  return handlers
}

describe('field options and exceptions MongoDB routes', () => {
  let connection
  let db

  beforeAll(async () => {
    connection = await mongoose.createConnection(process.env.MONGODB_URI, {
      dbName: `field_routes_${process.pid}`
    }).asPromise()
    db = createScopedDb(connection, 'team-tracker')
  })

  afterAll(async () => {
    await connection.db.dropDatabase()
    await connection.close()
  })

  it('round-trips option sets without writing per-field files', async () => {
    const storage = createStorage({ 'audit-log.json': { entries: [] } })
    const handlers = await register(storage, db)
    const put = response()
    await handlers['PUT /field-options/:name']({
      params: { name: 'components' },
      body: { label: 'Components', values: ['B', 'A'] },
      auditActor: 'admin@test.com'
    }, put)
    const get = response()
    await handlers['GET /field-options/:name']({ params: { name: 'components' } }, get)

    expect(put.statusCode).toBe(200)
    expect(get.body.values).toEqual(['A', 'B'])
    expect(storage.data['team-data/field-options/components.json']).toBeUndefined()
  })

  it('creates, lists, and deletes exceptions without writing the singleton file', async () => {
    const storage = createStorage({
      'team-data/registry.json': { people: { alice: { uid: 'alice', name: 'Alice' } } },
      'team-data/teams.json': { teams: {} },
      'team-data/field-definitions.json': {
        personFields: [{ id: 'field_focus', label: 'Focus', deleted: false }],
        teamFields: []
      },
      'audit-log.json': { entries: [] }
    })
    const handlers = await register(storage, db)
    const created = response()
    await handlers['POST /field-exceptions']({
      body: { entityType: 'person', entityId: 'alice', fieldId: 'field_focus', reason: 'Not applicable' },
      userEmail: 'admin@test.com'
    }, created)
    const listed = response()
    await handlers['GET /field-exceptions']({ query: {}, isAdmin: true }, listed)
    const removed = response()
    await handlers['DELETE /field-exceptions/:id']({
      params: { id: created.body.exception.id },
      userEmail: 'admin@test.com'
    }, removed)

    expect(created.statusCode).toBe(201)
    expect(listed.body.exceptions).toHaveLength(1)
    expect(removed.body).toEqual({ removed: true })
    expect(storage.data['team-data/field-exceptions.json']).toBeUndefined()
  })

  it('loads per-field and singleton fixtures into their document shapes', async () => {
    await seedFixtures(connection, [{
      slug: 'team-tracker',
      fixtures: {
        'team-data/field-options/component.json': 'field-option',
        'team-data/field-exceptions.json': 'field-exception'
      }
    }], [`${process.cwd()}/fixtures`])
    const handlers = await register(createStorage({ 'audit-log.json': { entries: [] } }), db)
    const options = response()
    await handlers['GET /field-options/:name']({ params: { name: 'component' } }, options)
    const exceptions = response()
    await handlers['GET /field-exceptions']({ query: {}, isAdmin: true }, exceptions)

    expect(options.body.name).toBe('components')
    expect(options.body.migrationDone).toBe(true)
    expect(exceptions.body.exceptions).toHaveLength(3)
    expect(exceptions.body.exceptions[0].id).toMatch(/^fex_/)
  })
})
