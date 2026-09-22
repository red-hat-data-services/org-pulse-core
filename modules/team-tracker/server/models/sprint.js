const mongoose = require('mongoose')

const sprintSchema = new mongoose.Schema({
  sprintId: { type: String, required: true, unique: true, index: true },
  boardId: { type: String, required: true, index: true },
  teamId: { type: String, required: true, index: true },
  boardName: { type: String, default: null },
  name: { type: String, default: null },
  state: { type: String, default: null },
  startDate: { type: String, default: null },
  endDate: { type: String, default: null },
  completeDate: { type: String, default: null },
  updatedAt: { type: String, default: null },
  associations: [{
    _id: false,
    boardId: { type: String, required: true },
    teamId: { type: String, required: true },
    boardName: { type: String, default: null }
  }],
  data: { type: mongoose.Schema.Types.Mixed, required: true }
})

module.exports = { sprintSchema }
