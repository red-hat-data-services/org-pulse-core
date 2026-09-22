/**
 * Sprint report and board-index storage. File mode preserves the existing keys.
 */
function createSprintStore(storage, options = {}) {
  const Model = options.model || null
  const BoardIndexModel = options.boardIndexModel || null

  async function getSprint(sprintId) {
    if (Model) {
      const doc = await Model.findOne({ sprintId: String(sprintId) }).lean()
      return doc ? doc.data : null
    }
    return storage.readFromStorage(`sprints/${sprintId}.json`)
  }

  async function writeSprint(teamId, boardName, processed) {
    const sprint = processed?.sprint || {}
    if (Model) {
      await Model.updateOne(
        { sprintId: String(sprint.id) },
        {
          $setOnInsert: {
            sprintId: String(sprint.id),
            boardId: String(sprint.boardId),
            teamId: String(teamId),
            boardName: boardName || null
          },
          $set: {
            name: sprint.name || null,
            state: sprint.state || null,
            startDate: sprint.startDate || null,
            endDate: sprint.endDate || null,
            completeDate: sprint.completeDate || null,
            updatedAt: new Date().toISOString(),
            data: processed
          },
          $addToSet: {
            associations: {
              boardId: String(sprint.boardId),
              teamId: String(teamId),
              boardName: boardName || null
            }
          }
        },
        { upsert: true }
      )
      return
    }
    await storage.writeToStorage(`sprints/${sprint.id}.json`, processed)
  }

  async function getBoardSprints(boardId, teamId) {
    const indexId = teamId || boardId
    if (!BoardIndexModel) {
      const teamIndex = await storage.readFromStorage(`sprints/team-${indexId}.json`)
      if (teamId) return teamIndex
      return teamIndex || (await storage.readFromStorage(`sprints/board-${boardId}.json`))
    }

    const teamIndex = await BoardIndexModel.findOne({ teamId: String(indexId) }).lean()
    const doc = teamId
      ? teamIndex
      : teamIndex || await BoardIndexModel.findOne({ boardId: String(boardId) }).lean()
    if (!doc) return null
    const { _id, __v, ...index } = doc
    return index
  }

  async function writeBoardIndex(teamId, boardId, boardName, sprints) {
    if (BoardIndexModel) {
      await BoardIndexModel.updateOne(
        { teamId: String(teamId) },
        {
          $set: {
            teamId: String(teamId),
            boardId: String(boardId),
            boardName: boardName || null,
            lastUpdated: new Date().toISOString(),
            sprints
          }
        },
        { upsert: true }
      )
      return
    }
    await storage.writeToStorage(`sprints/team-${teamId}.json`, {
      boardId,
      teamId,
      boardName,
      lastUpdated: new Date().toISOString(),
      sprints
    })
  }

  return {
    getSprint,
    writeSprint,
    getBoardSprints,
    writeBoardIndex,
    usesDatabase: !!Model
  }
}

module.exports = { createSprintStore }
