import { describe, it, expect } from 'vitest'

const teamStore = require('../../../../shared/server/team-store')

function makeStorage(initial = {}) {
  const data = { ...initial }
  return {
    async readFromStorage(key) { return data[key] ? JSON.parse(JSON.stringify(data[key])) : null },
    async writeToStorage(key, val) { data[key] = JSON.parse(JSON.stringify(val)) },
    _data: data
  }
}

describe('team-store createTeam', () => {
  it('initializes boards as empty array', async () => {
    const storage = makeStorage({
      'team-data/teams.json': { teams: {} },
      'audit-log.json': { entries: [] }
    })
    const team = await teamStore.createTeam(storage, 'New Team', 'org1', 'admin@test.com')
    expect(team.boards).toEqual([])
  })
})

describe('team-store updateTeamBoards', () => {
  it('replaces boards array', async () => {
    const storage = makeStorage({
      'team-data/teams.json': {
        teams: {
          team_abc: { id: 'team_abc', name: 'Platform', orgKey: 'achen', metadata: {}, boards: [] }
        }
      },
      'audit-log.json': { entries: [] }
    })

    const boards = [
      { url: 'https://jira.example.com/board/1', name: 'Board 1' },
      { url: 'https://jira.example.com/board/2' }
    ]
    const result = await teamStore.updateTeamBoards(storage, 'team_abc', boards, 'admin@test.com')
    expect(result).toHaveLength(2)
    expect(result[0].url).toBe('https://jira.example.com/board/1')
    expect(result[0].name).toBe('Board 1')
    expect(result[1].name).toBe('') // defaults to empty string
  })

  it('returns null for unknown team', async () => {
    const storage = makeStorage({
      'team-data/teams.json': { teams: {} },
      'audit-log.json': { entries: [] }
    })
    const result = await teamStore.updateTeamBoards(storage, 'team_nope', [], 'admin@test.com')
    expect(result).toBeNull()
  })

  it('creates audit log entry', async () => {
    const storage = makeStorage({
      'team-data/teams.json': {
        teams: {
          team_abc: { id: 'team_abc', name: 'Platform', orgKey: 'achen', metadata: {}, boards: [] }
        }
      },
      'audit-log.json': { entries: [] }
    })

    await teamStore.updateTeamBoards(storage, 'team_abc', [{ url: 'https://example.com', name: '' }], 'admin@test.com')
    const log = storage._data['audit-log.json']
    expect(log.entries.length).toBeGreaterThan(0)
    expect(log.entries[0].action).toBe('team.boards.update')
  })
})

describe('team-store updateTeamFields', () => {
  it('sets team field values', async () => {
    const storage = makeStorage({
      'team-data/teams.json': {
        teams: {
          team_abc: { id: 'team_abc', name: 'Platform', orgKey: 'achen', metadata: {} }
        }
      },
      'audit-log.json': { entries: [] }
    })

    const result = await teamStore.updateTeamFields(storage, 'team_abc', { field_x: 'hello' }, 'admin@test.com')
    expect(result.metadata).toEqual({ field_x: 'hello' })
  })

  it('handles multi-value arrays', async () => {
    const storage = makeStorage({
      'team-data/teams.json': {
        teams: {
          team_abc: { id: 'team_abc', name: 'Platform', orgKey: 'achen', metadata: {} }
        }
      },
      'audit-log.json': { entries: [] }
    })

    const result = await teamStore.updateTeamFields(storage, 'team_abc', { field_x: ['A', 'B'] }, 'admin@test.com')
    expect(result.metadata.field_x).toEqual(['A', 'B'])
  })

  it('returns null for unknown team', async () => {
    const storage = makeStorage({
      'team-data/teams.json': { teams: {} },
      'audit-log.json': { entries: [] }
    })

    const result = await teamStore.updateTeamFields(storage, 'team_nope', { field_x: 'y' }, 'admin@test.com')
    expect(result).toBeNull()
  })

  it('creates audit log entries', async () => {
    const storage = makeStorage({
      'team-data/teams.json': {
        teams: {
          team_abc: { id: 'team_abc', name: 'Platform', orgKey: 'achen', metadata: {} }
        }
      },
      'audit-log.json': { entries: [] }
    })

    await teamStore.updateTeamFields(storage, 'team_abc', { field_x: 'hello' }, 'admin@test.com')
    const log = storage._data['audit-log.json']
    expect(log.entries.length).toBeGreaterThan(0)
    expect(log.entries[0].action).toBe('team.field.update')
  })
})
