const mongoose = require('mongoose')

const boardSchema = new mongoose.Schema({
  url: { type: String, required: true },
  name: { type: String, default: '' },
  boardId: { type: Number, default: null },
  sprintFilter: { type: String }
}, { _id: false })

const teamSchema = new mongoose.Schema({
  teamId: { type: String, required: true, unique: true, index: true },
  name: { type: String, required: true },
  orgKey: { type: String, required: true, index: true },
  createdBy: { type: String },
  createdAt: { type: String },
  description: { type: String, default: null },
  metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
  boards: { type: [boardSchema], default: [] }
}, {
  // No timestamps: the store manages createdBy/createdAt explicitly, matching
  // the file-based format. Mongoose createdAt/updatedAt would only duplicate them.
  collection: 'core__teams'
})

module.exports = { teamSchema }
