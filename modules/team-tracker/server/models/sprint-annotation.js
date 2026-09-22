const mongoose = require('mongoose')

// Assignee names can contain dots, so entries are stored as an array instead
// of a map whose user-controlled keys MongoDB could interpret as paths.
const sprintAnnotationSchema = new mongoose.Schema({
  sprintId: { type: String, required: true, unique: true, index: true },
  entries: [{
    id: { type: String, required: true },
    assignee: { type: String, required: true },
    text: { type: String, required: true },
    author: { type: String, default: null },
    createdAt: { type: String, default: null }
  }]
})

module.exports = { sprintAnnotationSchema }
