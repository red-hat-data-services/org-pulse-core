import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import mongoose from 'mongoose'

const { createSprintStore } = require('../sprint-store')
const { sprintSchema } = require('../models/sprint')
const { sprintBoardIndexSchema } = require('../models/sprint-board-index')

function createStorage(initial = {}) {
  const data = structuredClone(initial)
  return {
    async readFromStorage(key) { return data[key] ? structuredClone(data[key]) : null },
    async writeToStorage(key, value) { data[key] = structuredClone(value) },
    data
  }
}

function sprint(id = 501, state = 'closed') {
  return {
    sprint: {
      id,
      name: `Sprint ${id}`,
      state,
      startDate: '2026-01-01T00:00:00.000Z',
      endDate: '2026-01-14T00:00:00.000Z',
      completeDate: '2026-01-14T00:00:00.000Z',
      boardId: 9
    },
    committed: { totalPoints: 20, issues: [] },
    delivered: { totalPoints: 18, issues: [] },
    byAssignee: {},
    metrics: { velocityPoints: 18 }
  }
}

describe('sprint store file path', () => {
  it('persists and reads the existing sprint and team-index keys', async () => {
    const storage = createStorage()
    const store = createSprintStore(storage)
    const report = sprint()

    await store.writeSprint('team-9', 'Platform', report)
    await store.writeBoardIndex('team-9', 9, 'Platform', [report.sprint])

    expect(await store.getSprint(501)).toEqual(report)
    expect(await store.getBoardSprints('team-9')).toMatchObject({
      boardId: 9,
      teamId: 'team-9',
      boardName: 'Platform',
      sprints: [report.sprint]
    })
    expect(storage.data['sprints/501.json']).toEqual(report)
    expect(storage.data['sprints/team-team-9.json']).toBeDefined()
  })

  it('falls back to the legacy board index and returns null for missing data', async () => {
    const legacy = { boardId: 9, sprints: [{ id: 501 }] }
    const store = createSprintStore(createStorage({ 'sprints/board-9.json': legacy }))

    expect(await store.getBoardSprints('9')).toEqual(legacy)
    expect(await store.getSprint('missing')).toBeNull()
    expect(store.usesDatabase).toBe(false)
  })
})

describe('sprint store MongoDB path', () => {
  let connection
  let Model
  let BoardIndexModel

  beforeAll(async () => {
    connection = await mongoose.createConnection(process.env.MONGODB_URI, {
      dbName: `test_team_tracker_sprints_${process.pid}`
    }).asPromise()
    Model = connection.model('sprint', sprintSchema, 'team_tracker__sprint_test')
    BoardIndexModel = connection.model('sprint-board-index', sprintBoardIndexSchema, 'team_tracker__sprint_board_index_test')
  })

  beforeEach(async () => Promise.all([Model.deleteMany({}), BoardIndexModel.deleteMany({})]))

  afterAll(async () => {
    await connection.db.dropDatabase()
    await connection.close()
  })

  it('persists reports and the exact board index across store instances', async () => {
    const first = createSprintStore(createStorage(), { model: Model, boardIndexModel: BoardIndexModel })
    await first.writeSprint('team-9', 'Platform', sprint(501))
    await first.writeSprint('team-9', 'Platform', sprint(502, 'active'))
    const metadata = [
      { id: 700, name: 'Removed sprint', state: 'closed', completeDate: '2025-01-01T00:00:00.000Z' },
      { id: 501, name: 'Stale sprint name', state: 'closed', completeDate: '2026-02-01T00:00:00.000Z' }
    ]
    await first.writeBoardIndex('team-9', 9, 'Platform', metadata)

    const second = createSprintStore(createStorage(), { model: Model, boardIndexModel: BoardIndexModel })
    expect(await second.getSprint(501)).toEqual(sprint(501))
    const index = await second.getBoardSprints('team-9')
    expect(index.sprints).toEqual(metadata)
    expect(index).toMatchObject({ boardId: '9', teamId: 'team-9', boardName: 'Platform' })
    expect(await second.getBoardSprints('9')).toMatchObject({ teamId: 'team-9' })
    expect(second.usesDatabase).toBe(true)
  })

  it('keeps one sprint associated with two independently persisted team indexes', async () => {
    const store = createSprintStore(createStorage(), { model: Model, boardIndexModel: BoardIndexModel })
    const report = sprint(501)
    const firstIndex = [{ id: 501, name: 'Platform sprint', state: 'closed' }]
    const secondIndex = [{ id: 501, name: 'Filtered sprint', state: 'closed' }]

    await store.writeSprint('platform', 'Platform', report)
    await store.writeSprint('platform-filtered', 'Platform', report)
    await store.writeBoardIndex('platform', 9, 'Platform', firstIndex)
    await store.writeBoardIndex('platform-filtered', 9, 'Platform', secondIndex)

    expect((await store.getBoardSprints('platform')).sprints).toEqual(firstIndex)
    expect((await store.getBoardSprints('platform-filtered')).sprints).toEqual(secondIndex)
    expect((await store.getBoardSprints(9, 'platform-filtered')).sprints).toEqual(secondIndex)
    expect((await Model.findOne({ sprintId: '501' }).lean()).associations).toEqual([
      { boardId: '9', teamId: 'platform', boardName: 'Platform' },
      { boardId: '9', teamId: 'platform-filtered', boardName: 'Platform' }
    ])

    await store.writeBoardIndex('platform', 9, 'Platform', [])
    expect((await store.getBoardSprints('platform')).sprints).toEqual([])
    expect((await store.getBoardSprints('platform-filtered')).sprints).toEqual(secondIndex)
  })

  it('returns null when no sprint or board matches', async () => {
    const store = createSprintStore(createStorage(), { model: Model, boardIndexModel: BoardIndexModel })
    expect(await store.getSprint('missing')).toBeNull()
    expect(await store.getBoardSprints('missing')).toBeNull()
  })
})
