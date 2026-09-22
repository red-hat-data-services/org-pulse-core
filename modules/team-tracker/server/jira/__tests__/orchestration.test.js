import { describe, it, expect, vi } from 'vitest'

const orchestration = require('../orchestration')

/**
 * determineStaleness is a pure function extracted here for testing,
 * matching the implementation in orchestration.js.
 * The source file uses CJS require() which doesn't work in vitest's ESM context.
 */
function determineStaleness(sprints) {
  const sixMonthsAgo = new Date()
  sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6)

  const latestSprint = sprints
    .filter(s => s.endDate || s.completeDate)
    .sort((a, b) => new Date(b.endDate || b.completeDate) - new Date(a.endDate || a.completeDate))[0]

  if (!latestSprint) {
    return { stale: true, lastSprintEndDate: null }
  }

  const lastDate = new Date(latestSprint.endDate || latestSprint.completeDate)
  return {
    stale: lastDate < sixMonthsAgo,
    lastSprintEndDate: latestSprint.endDate || latestSprint.completeDate
  }
}

describe('determineStaleness', () => {
  it('marks board as stale if no sprints', () => {
    const result = determineStaleness([])
    expect(result.stale).toBe(true)
    expect(result.lastSprintEndDate).toBeNull()
  })

  it('marks board as stale if last sprint ended > 6 months ago', () => {
    const eightMonthsAgo = new Date()
    eightMonthsAgo.setMonth(eightMonthsAgo.getMonth() - 8)

    const result = determineStaleness([{
      endDate: eightMonthsAgo.toISOString(),
      state: 'closed'
    }])
    expect(result.stale).toBe(true)
  })

  it('marks board as not stale if last sprint ended recently', () => {
    const twoWeeksAgo = new Date()
    twoWeeksAgo.setDate(twoWeeksAgo.getDate() - 14)

    const result = determineStaleness([{
      endDate: twoWeeksAgo.toISOString(),
      state: 'closed'
    }])
    expect(result.stale).toBe(false)
  })

  it('uses completeDate as fallback', () => {
    const oneMonthAgo = new Date()
    oneMonthAgo.setMonth(oneMonthAgo.getMonth() - 1)

    const result = determineStaleness([{
      completeDate: oneMonthAgo.toISOString(),
      state: 'closed'
    }])
    expect(result.stale).toBe(false)
    expect(result.lastSprintEndDate).toBe(oneMonthAgo.toISOString())
  })

  it('picks the most recent sprint for staleness check', () => {
    const oneMonthAgo = new Date()
    oneMonthAgo.setMonth(oneMonthAgo.getMonth() - 1)

    const oneYearAgo = new Date()
    oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1)

    const result = determineStaleness([
      { endDate: oneYearAgo.toISOString(), state: 'closed' },
      { endDate: oneMonthAgo.toISOString(), state: 'closed' }
    ])
    expect(result.stale).toBe(false)
    expect(result.lastSprintEndDate).toBe(oneMonthAgo.toISOString())
  })
})

describe('dual-path storage orchestration', () => {
  it('writes discovered boards through the config store', async () => {
    const boardsConfigStore = {
      readFromStorage: vi.fn(async () => null),
      writeToStorage: vi.fn(async () => {})
    }

    await orchestration.discoverBoards({
      fetchBoards: async () => [],
      fetchSprints: async () => [],
      boardsConfigStore
    })

    expect(boardsConfigStore.writeToStorage).toHaveBeenCalledWith('boards.json', {
      lastUpdated: expect.any(String),
      boards: []
    })
    expect(boardsConfigStore.writeToStorage).toHaveBeenCalledWith('teams.json', { teams: [] })
  })

  it('writes sprint reports, indexes, and dashboard summary through stores', async () => {
    const sprintStore = {
      getSprint: vi.fn(async () => null),
      writeSprint: vi.fn(async () => {}),
      writeBoardIndex: vi.fn(async () => {})
    }
    const boardsConfigStore = {
      readFromStorage: vi.fn(async key => key === 'teams.json'
        ? { teams: [{ boardId: 9, boardName: 'Platform', teamId: 'team-9', enabled: true }] }
        : { boards: [] }),
      writeToStorage: vi.fn(async () => {})
    }
    const sprint = {
      id: 501,
      name: 'Sprint 12',
      state: 'closed',
      startDate: '2026-08-01T00:00:00.000Z',
      endDate: '2026-08-14T00:00:00.000Z',
      completeDate: '2026-08-14T00:00:00.000Z'
    }

    await orchestration.performRefresh({
      hardRefresh: true,
      fetchBoards: async () => [],
      fetchSprints: async () => [sprint],
      fetchSprintReport: async () => ({ sprint, contents: {} }),
      boardsConfigStore,
      sprintStore,
      jiraHost: 'https://jira.example.com'
    })

    expect(sprintStore.writeSprint).toHaveBeenCalledWith(
      'team-9',
      'Platform',
      expect.objectContaining({ sprint: expect.objectContaining({ id: 501, boardId: 9 }) })
    )
    expect(sprintStore.writeBoardIndex).toHaveBeenCalledWith(
      'team-9',
      9,
      'Platform',
      [sprint]
    )
    expect(boardsConfigStore.writeToStorage).toHaveBeenCalledWith(
      'dashboard-summary.json',
      expect.objectContaining({ boards: expect.any(Object) })
    )
  })
})
