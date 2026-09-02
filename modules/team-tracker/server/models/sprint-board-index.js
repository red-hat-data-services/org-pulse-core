const mongoose = require('mongoose')

const sprintBoardIndexSchema = new mongoose.Schema({
  teamId: { type: String, required: true, unique: true, index: true },
  boardId: { type: String, required: true, index: true },
  boardName: { type: String, default: null },
  lastUpdated: { type: String, required: true },
  sprints: { type: [mongoose.Schema.Types.Mixed], default: [] }
})

module.exports = { sprintBoardIndexSchema }
