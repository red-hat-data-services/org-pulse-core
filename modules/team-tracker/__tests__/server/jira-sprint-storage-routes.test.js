const { createAuditLog } = require('../../../../shared/server/audit-log')
const { createConfigStore } = require('../../../../shared/server/config-store')
const { createFieldStore } = require('../../../../shared/server/field-store')
const { createRegistryStore } = require('../../../../shared/server/registry-store')
const { createTeamStore } = require('../../../../shared/server/team-store')
const { createScopedDb } = require('../../../../shared/server/scoped-db')
const { createSprintStore } = require('../../server/sprint-store')
const { configSchema } = require('../../../../shared/server/models/config')
const { sprintSchema } = require('../../server/models/sprint')
const { sprintBoardIndexSchema } = require('../../server/models/sprint-board-index')
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
    router[method] = (path, ...callbacks) => {
      handlers[`${method.toUpperCase()} ${path}`] = callbacks.at(-1)
    }
  }
  return { router, handlers }
}

function createResponse() {
  const response = {
    statusCode: 200,
    body: null,
    status(code) { response.statusCode = code; return response },
    json(body) { response.body = body; return response }
  }
  return response
}

async function register(storage, db = null) {
  const { router, handlers } = createRouter()
  const auditLog = createAuditLog(storage)
  const registryStore = createRegistryStore(storage)
  const context = {
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
  }
  await require('../../server/index.js')(router, context)
  return handlers
}

function report() {
  return {
    sprint: {
      id: 501,
      name: 'Sprint 12',
      state: 'closed',
      startDate: '2026-01-01T00:00:00.000Z',
      endDate: '2026-01-14T00:00:00.000Z',
      completeDate: '2026-01-14T00:00:00.000Z',
      boardId: 9
    },
    committed: { totalPoints: 20, issues: [] },
    delivered: { totalPoints: 18, issues: [] },
    metrics: { velocityPoints: 18, scopeChangeCount: 0 }
  }
}

describe('Jira sprint storage routes', () => {
  let connection
  let db

  beforeAll(async () => {
    connection = await mongoose.createConnection(process.env.MONGODB_URI, {
      dbName: `test_team_tracker_sprint_routes_${process.pid}`
    }).asPromise()
    db = createScopedDb(connection, 'team-tracker')
  })

  afterAll(async () => {
    await connection.db.dropDatabase()
    await connection.close()
  })

  it('preserves file-backed route behavior without models', async () => {
    const data = report()
    const storage = createStorage({
      'team-data/registry.json': { people: {} },
      'teams.json': { teams: [{ boardId: 9, enabled: true }] },
      'boards.json': { lastUpdated: 'file-time' },
      'sprints/team-9.json': { boardId: 9, sprints: [data.sprint] },
      'sprints/501.json': data,
      'dashboard-summary.json': { lastUpdated: 'file-time', boards: { 9: {} } }
    })
    const handlers = await register(storage)

    const boardResponse = createResponse()
    await handlers['GET /boards']({}, boardResponse)
    expect(boardResponse.body.lastUpdated).toBe('file-time')

    const sprintResponse = createResponse()
    await handlers['GET /sprints/:sprintId']({ params: { sprintId: '501' } }, sprintResponse)
    expect(sprintResponse.body).toEqual(data)

    const summaryResponse = createResponse()
    await handlers['GET /dashboard-summary']({}, summaryResponse)
    expect(summaryResponse.body).toEqual({ lastUpdated: 'file-time', boards: { 9: {} } })
  })

  it('reads MongoDB-backed boards, sprints, and dashboard data without raw storage reads', async () => {
    const storage = createStorage({
      'team-data/registry.json': { people: {} },
      'teams.json': { teams: [{ boardId: 9, enabled: true }] }
    })
    const configStore = createConfigStore(storage, { model: db.model('config', configSchema) })
    const sprintStore = createSprintStore(storage, {
      model: db.model('sprint', sprintSchema),
      boardIndexModel: db.model('sprint-board-index', sprintBoardIndexSchema)
    })
    await configStore.writeToStorage('boards.json', { lastUpdated: 'mongo-time' })
    await configStore.writeToStorage('teams.json', { teams: [{ boardId: 9, enabled: true }] })
    await configStore.writeToStorage('dashboard-summary.json', { lastUpdated: 'mongo-time', boards: { 9: {} } })
    await sprintStore.writeSprint('9', 'Platform', report())
    const handlers = await register(storage, db)

    const boardResponse = createResponse()
    await handlers['GET /boards']({}, boardResponse)
    expect(boardResponse.body.lastUpdated).toBe('mongo-time')

    const sprintResponse = createResponse()
    await handlers['GET /sprints/:sprintId']({ params: { sprintId: '501' } }, sprintResponse)
    expect(sprintResponse.body).toEqual(report())

    const summaryResponse = createResponse()
    await handlers['GET /dashboard-summary']({}, summaryResponse)
    expect(summaryResponse.body.lastUpdated).toBe('mongo-time')
    expect(storage.readFromStorage).not.toHaveBeenCalledWith('boards.json')
    expect(storage.readFromStorage).not.toHaveBeenCalledWith('teams.json')
    expect(storage.readFromStorage).not.toHaveBeenCalledWith('sprints/501.json')
    expect(storage.readFromStorage).not.toHaveBeenCalledWith('dashboard-summary.json')

    const saveConfigResponse = createResponse()
    await handlers['POST /admin/jira-sync/config']({ body: { projectKeys: ['rhoai'] } }, saveConfigResponse)
    expect(saveConfigResponse.body.projectKeys).toEqual(['RHOAI'])
    const readConfigResponse = createResponse()
    await handlers['GET /admin/jira-sync/config']({}, readConfigResponse)
    expect(readConfigResponse.body.projectKeys).toEqual(['RHOAI'])
    expect(storage.readFromStorage).not.toHaveBeenCalledWith('jira-sync-config.json')
    expect(storage.writeToStorage).not.toHaveBeenCalledWith('jira-sync-config.json', expect.anything())
  })

  it('uses teamId to select one of two indexes for the same physical board', async () => {
    const storage = createStorage({
      'team-data/registry.json': { people: {} },
      'teams.json': { teams: [{ boardId: 9, enabled: true }] }
    })
    const sprintStore = createSprintStore(storage, {
      model: db.model('sprint', sprintSchema),
      boardIndexModel: db.model('sprint-board-index', sprintBoardIndexSchema)
    })
    const backend = report()
    const frontend = { ...report(), sprint: { ...report().sprint, id: 502, name: 'Frontend Sprint' } }
    await sprintStore.writeSprint('platform-backend', 'Platform', backend)
    await sprintStore.writeSprint('platform-frontend', 'Platform', frontend)
    await sprintStore.writeBoardIndex('platform-backend', 9, 'Platform', [backend.sprint])
    await sprintStore.writeBoardIndex('platform-frontend', 9, 'Platform', [frontend.sprint])
    const handlers = await register(storage, db)

    const sprintResponse = createResponse()
    await handlers['GET /boards/:boardId/sprints']({
      params: { boardId: '9' },
      query: { teamId: 'platform-frontend' }
    }, sprintResponse)
    expect(sprintResponse.body.sprints).toEqual([frontend.sprint])

    const trendResponse = createResponse()
    await handlers['GET /boards/:boardId/trend']({
      params: { boardId: '9' },
      query: { teamId: 'platform-frontend' }
    }, trendResponse)
    expect(trendResponse.body.sprints).toMatchObject([{ sprintId: 502, sprintName: 'Frontend Sprint' }])
  })

  it('persists an annotation across separate MongoDB-backed route registrations', async () => {
    const firstStorage = createStorage({ 'team-data/registry.json': { people: {} } })
    const firstHandlers = await register(firstStorage, db)
    const putResponse = createResponse()
    await firstHandlers['PUT /sprints/:sprintId/annotations']({
      params: { sprintId: '501' },
      body: { assignee: 'Alice B. Smith', text: 'On PTO' },
      userEmail: 'manager@example.com'
    }, putResponse)

    const secondStorage = createStorage({ 'team-data/registry.json': { people: {} } })
    const secondHandlers = await register(secondStorage, db)
    const getResponse = createResponse()
    await secondHandlers['GET /sprints/:sprintId/annotations'](
      { params: { sprintId: '501' } },
      getResponse
    )

    expect(getResponse.body.annotations['Alice B. Smith']).toEqual([putResponse.body])
    expect(firstStorage.writeToStorage).not.toHaveBeenCalledWith(
      'annotations/501.json',
      expect.anything()
    )
    expect(secondStorage.readFromStorage).not.toHaveBeenCalledWith('annotations/501.json')
  })
})
